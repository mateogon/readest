package com.readest.native_tts

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred

internal enum class NativeTtsOperationKind {
    DIRECT_SPEAK,
    FILE_SYNTHESIS,
    CONFIGURATION,
}

internal data class NativeTtsOperationClaim(
    val kind: NativeTtsOperationKind,
    val id: String,
) {
    internal val released = CompletableDeferred<Unit>()
}

internal class NativeTtsOperationGate {
    private val active = AtomicReference<NativeTtsOperationClaim?>(null)

    fun tryAcquire(kind: NativeTtsOperationKind, id: String): NativeTtsOperationClaim? {
        val claim = NativeTtsOperationClaim(kind, id)
        return claim.takeIf { active.compareAndSet(null, claim) }
    }

    fun release(claim: NativeTtsOperationClaim): Boolean {
        if (!active.compareAndSet(claim, null)) return false
        claim.released.complete(Unit)
        return true
    }

    fun release(kind: NativeTtsOperationKind, id: String): Boolean {
        val claim = active.get()?.takeIf { it.kind == kind && it.id == id } ?: return false
        return release(claim)
    }

    fun activeClaim(): NativeTtsOperationClaim? = active.get()

    fun isIdle(): Boolean = active.get() == null

    fun forceRelease() {
        active.getAndSet(null)?.released?.complete(Unit)
    }
}

internal data class SynthesisRequestKey(
    val sessionId: String,
    val requestId: String,
    val generation: Long,
)

internal data class RawSynthesisRange(
    val start: Int,
    val end: Int,
    val frame: Long,
)

internal data class SynthesisAsset(
    val assetId: String,
    val sampleRate: Int,
    val frameCount: Long,
    val durationSec: Double,
    val enginePackage: String,
    val engineVersion: String,
    val maxInputLength: Int,
    val ranges: List<RawSynthesisRange>,
)

internal sealed interface SynthesisTerminal {
    data class Ready(val asset: SynthesisAsset) : SynthesisTerminal
    data class Failed(val message: String) : SynthesisTerminal
    object Cancelled : SynthesisTerminal
}

internal class SynthesisBusyException : IllegalStateException("A file synthesis is already active")

internal class SynthesisCancelledException :
    IllegalStateException("The file synthesis was cancelled before it started")

internal class UnknownSynthesisAssetException :
    IllegalArgumentException("The synthesis asset is unknown or was already consumed")

private data class ReadySynthesisFile(
    val key: SynthesisRequestKey,
    val file: File,
)

internal class ActiveFileSynthesis internal constructor(
    val key: SynthesisRequestKey,
    val text: String,
    val assetId: String,
    val utteranceId: String,
    val outputFile: File,
) {
    val terminal = CompletableDeferred<SynthesisTerminal>()
    internal val ranges = Collections.synchronizedList(mutableListOf<RawSynthesisRange>())
    internal val terminalStarted = AtomicBoolean(false)
    internal val cancelRequested = AtomicBoolean(false)
}

internal class FileSynthesisBroker(private val cacheDirectory: File) {
    private val stateLock = Any()
    private val active = AtomicReference<ActiveFileSynthesis?>(null)
    private val readyAssets = ConcurrentHashMap<String, ReadySynthesisFile>()
    private val cancelledBeforeStart = linkedSetOf<SynthesisRequestKey>()

    init {
        check(cacheDirectory.mkdirs() || cacheDirectory.isDirectory) {
            "Unable to create the private TTS synthesis cache"
        }
        cleanupOrphans()
    }

    fun begin(key: SynthesisRequestKey, text: String): ActiveFileSynthesis {
        val assetId = UUID.randomUUID().toString()
        val outputFile = File(cacheDirectory, "$assetId.wav")
        check(outputFile.createNewFile()) { "Unable to create a private synthesis file" }
        val candidate =
            ActiveFileSynthesis(
                key = key,
                text = text,
                assetId = assetId,
                utteranceId = "file-$assetId",
                outputFile = outputFile,
            )
        synchronized(stateLock) {
            if (cancelledBeforeStart.remove(key)) {
                outputFile.delete()
                throw SynthesisCancelledException()
            }
            if (active.get() != null) {
                outputFile.delete()
                throw SynthesisBusyException()
            }
            active.set(candidate)
        }
        return candidate
    }

    fun activeRequest(): ActiveFileSynthesis? = active.get()

    fun activeForUtterance(utteranceId: String?): ActiveFileSynthesis? =
        active.get()?.takeIf { it.utteranceId == utteranceId }

    fun addRange(utteranceId: String?, range: RawSynthesisRange) {
        val current = activeForUtterance(utteranceId) ?: return
        if (!current.terminalStarted.get()) {
            current.ranges.add(range)
        }
    }

    fun requestCancel(key: SynthesisRequestKey): ActiveFileSynthesis? {
        synchronized(stateLock) {
            val current = active.get()?.takeIf { it.key == key }
            if (current != null) {
                current.cancelRequested.set(true)
                return current
            }
            if (!discardReadyLocked(key)) rememberCancelledBeforeStart(key)
            return null
        }
    }

    fun discardReady(key: SynthesisRequestKey) {
        synchronized(stateLock) {
            discardReadyLocked(key)
        }
    }

    private fun discardReadyLocked(key: SynthesisRequestKey): Boolean {
        var discarded = false
        readyAssets.entries.forEach { entry ->
            val ready = entry.value
            if (ready.key == key && readyAssets.remove(entry.key, ready)) {
                ready.file.delete()
                discarded = true
            }
        }
        return discarded
    }

    fun finishSuccess(
        request: ActiveFileSynthesis,
        enginePackage: String,
        engineVersion: String,
        maxInputLength: Int,
    ): Boolean {
        if (!request.terminalStarted.compareAndSet(false, true)) return false
        val prepared =
            try {
                val wav = parsePcmWav(request.outputFile.readBytes())
                val rangesSnapshot = synchronized(request.ranges) { request.ranges.toList() }
                val ranges =
                    validateSynthesisRanges(
                        text = request.text,
                        frameCount = wav.frameCount,
                        ranges = rangesSnapshot,
                    )
                SynthesisTerminal.Ready(
                    SynthesisAsset(
                        assetId = request.assetId,
                        sampleRate = wav.sampleRate,
                        frameCount = wav.frameCount,
                        durationSec = wav.durationSec,
                        enginePackage = enginePackage,
                        engineVersion = engineVersion,
                        maxInputLength = maxInputLength,
                        ranges = ranges,
                    ),
                )
            } catch (error: Exception) {
                SynthesisTerminal.Failed(error.message ?: "Invalid synthesis WAV")
            }
        val terminal =
            synchronized(stateLock) {
                val settled =
                    if (request.cancelRequested.get()) SynthesisTerminal.Cancelled else prepared
                if (settled is SynthesisTerminal.Ready) {
                    readyAssets[request.assetId] =
                        ReadySynthesisFile(request.key, request.outputFile)
                } else {
                    request.outputFile.delete()
                }
                active.compareAndSet(request, null)
                settled
            }
        request.terminal.complete(terminal)
        return true
    }

    fun finishError(request: ActiveFileSynthesis, message: String): Boolean {
        if (!request.terminalStarted.compareAndSet(false, true)) return false
        val terminal =
            synchronized(stateLock) {
                val settled =
                    if (request.cancelRequested.get()) {
                        SynthesisTerminal.Cancelled
                    } else {
                        SynthesisTerminal.Failed(message)
                    }
                active.compareAndSet(request, null)
                settled
            }
        try {
            request.outputFile.delete()
        } finally {
            request.terminal.complete(terminal)
        }
        return true
    }

    fun finishCancelled(request: ActiveFileSynthesis): Boolean {
        request.cancelRequested.set(true)
        return finishError(request, "Synthesis cancelled")
    }

    fun readAndDelete(assetId: String): ByteArray {
        val file =
            synchronized(stateLock) {
                readyAssets.remove(assetId)?.file
            } ?: throw UnknownSynthesisAssetException()
        try {
            check(file.canonicalFile.parentFile == cacheDirectory.canonicalFile) {
                "Synthesis asset escaped its private cache"
            }
            return file.readBytes()
        } finally {
            file.delete()
        }
    }

    fun shutdown() {
        active.get()?.let(::finishCancelled)
        synchronized(stateLock) {
            readyAssets.values.forEach { it.file.delete() }
            readyAssets.clear()
            cancelledBeforeStart.clear()
        }
        cleanupOrphans()
    }

    private fun rememberCancelledBeforeStart(key: SynthesisRequestKey) {
        if (cancelledBeforeStart.size >= 256) {
            cancelledBeforeStart.remove(cancelledBeforeStart.first())
        }
        cancelledBeforeStart.add(key)
    }

    private fun cleanupOrphans() {
        cacheDirectory.listFiles().orEmpty().forEach { file ->
            if (file.isFile) file.delete()
        }
    }
}

internal data class PcmWavMetadata(
    val sampleRate: Int,
    val frameCount: Long,
    val durationSec: Double,
)

internal fun parsePcmWav(bytes: ByteArray): PcmWavMetadata {
    require(bytes.size >= 44) { "Synthesis output is too short to be a WAV" }
    require(bytes.ascii(0, 4) == "RIFF" && bytes.ascii(8, 4) == "WAVE") {
        "Synthesis output is not a RIFF/WAVE file"
    }

    val riffSize = bytes.readUnsignedInt32(4)
    require(riffSize + 8L == bytes.size.toLong()) { "WAV RIFF length does not match the file" }

    var format: Int? = null
    var channels: Int? = null
    var sampleRate: Int? = null
    var byteRate: Long? = null
    var blockAlign: Int? = null
    var bitsPerSample: Int? = null
    var dataSize: Long? = null
    var cursor = 12
    while (cursor + 8 <= bytes.size) {
        val chunkId = bytes.ascii(cursor, 4)
        val chunkSize = bytes.readUnsignedInt32(cursor + 4)
        val payloadStart = cursor + 8
        val payloadEnd = payloadStart.toLong() + chunkSize
        require(payloadEnd <= bytes.size.toLong()) { "WAV chunk exceeds the file" }

        when (chunkId) {
            "fmt " -> {
                require(chunkSize >= 16) { "WAV format chunk is too short" }
                format = bytes.readUnsignedInt16(payloadStart)
                channels = bytes.readUnsignedInt16(payloadStart + 2)
                val parsedSampleRate = bytes.readUnsignedInt32(payloadStart + 4)
                require(parsedSampleRate in 1..Int.MAX_VALUE.toLong()) { "Invalid WAV sample rate" }
                sampleRate = parsedSampleRate.toInt()
                byteRate = bytes.readUnsignedInt32(payloadStart + 8)
                blockAlign = bytes.readUnsignedInt16(payloadStart + 12)
                bitsPerSample = bytes.readUnsignedInt16(payloadStart + 14)
            }
            "data" -> dataSize = chunkSize
        }

        val paddedSize = chunkSize + (chunkSize and 1L)
        val next = payloadStart.toLong() + paddedSize
        require(next <= Int.MAX_VALUE.toLong()) { "WAV is too large" }
        cursor = next.toInt()
    }

    require(format == 1) { "Only PCM WAV synthesis output is supported" }
    val parsedChannels = requireNotNull(channels) { "WAV has no format chunk" }
    val parsedSampleRate = requireNotNull(sampleRate) { "WAV has no sample rate" }
    val parsedByteRate = requireNotNull(byteRate) { "WAV has no byte rate" }
    val parsedBlockAlign = requireNotNull(blockAlign) { "WAV has no block alignment" }
    val parsedBitsPerSample = requireNotNull(bitsPerSample) { "WAV has no bit depth" }
    val parsedDataSize = requireNotNull(dataSize) { "WAV has no audio data chunk" }
    require(parsedChannels == 1 && parsedBitsPerSample == 16 && parsedBlockAlign == 2) {
        "Only mono PCM16 WAV synthesis output is supported"
    }
    require(parsedByteRate == parsedSampleRate.toLong() * parsedBlockAlign.toLong()) {
        "Invalid WAV byte rate"
    }
    require(parsedDataSize > 0 && parsedDataSize % parsedBlockAlign == 0L) {
        "Invalid WAV audio data length"
    }
    val frameCount = parsedDataSize / parsedBlockAlign
    return PcmWavMetadata(
        sampleRate = parsedSampleRate,
        frameCount = frameCount,
        durationSec = frameCount.toDouble() / parsedSampleRate.toDouble(),
    )
}

internal fun validateSynthesisRanges(
    text: String,
    frameCount: Long,
    ranges: List<RawSynthesisRange>,
): List<RawSynthesisRange> {
    if (ranges.isEmpty()) return emptyList()
    var previousEnd = 0
    var previousFrame = -1L
    for (range in ranges) {
        val valid =
            range.start >= previousEnd &&
                range.start >= 0 &&
                range.start < range.end &&
                range.end <= text.length &&
                isUtf16Boundary(text, range.start) &&
                isUtf16Boundary(text, range.end) &&
                range.frame > previousFrame &&
                range.frame >= 0 &&
                range.frame < frameCount
        if (!valid) return emptyList()
        previousEnd = range.end
        previousFrame = range.frame
    }
    return ranges.toList()
}

private fun isUtf16Boundary(text: String, index: Int): Boolean {
    if (index <= 0 || index >= text.length) return true
    return !(text[index - 1].isHighSurrogate() && text[index].isLowSurrogate())
}

private fun ByteArray.ascii(offset: Int, length: Int): String =
    String(this, offset, length, Charsets.US_ASCII)

private fun ByteArray.readUnsignedInt16(offset: Int): Int =
    ByteBuffer.wrap(this, offset, 2).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xffff

private fun ByteArray.readUnsignedInt32(offset: Int): Long =
    ByteBuffer.wrap(this, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffff_ffffL
