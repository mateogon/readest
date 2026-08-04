package com.readest.native_tts

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileSynthesisBrokerTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun operationClaimMakesDirectFileAndConfigurationMutuallyExclusive() {
        val gate = NativeTtsOperationGate()
        val file =
            gate.tryAcquire(NativeTtsOperationKind.FILE_SYNTHESIS, "file")
                ?: throw AssertionError("file claim should succeed")

        assertEquals(null, gate.tryAcquire(NativeTtsOperationKind.DIRECT_SPEAK, "direct"))
        assertEquals(null, gate.tryAcquire(NativeTtsOperationKind.CONFIGURATION, "voice"))
        assertFalse(file.released.isCompleted)
        assertFalse(gate.release(NativeTtsOperationClaim(NativeTtsOperationKind.FILE_SYNTHESIS, "other")))
        assertTrue(gate.release(file))
        assertTrue(file.released.isCompleted)

        val direct =
            gate.tryAcquire(NativeTtsOperationKind.DIRECT_SPEAK, "direct")
                ?: throw AssertionError("direct claim should succeed after file releases")
        assertTrue(gate.release(direct))
        assertTrue(gate.isIdle())
    }

    @Test
    fun cancelBeforeBeginPreventsLateSynthesisRegistration() {
        val broker = broker()
        val requestKey = key("cancel-before-begin")

        assertEquals(null, broker.requestCancel(requestKey))
        assertEquals(null, broker.requestCancel(requestKey))
        assertThrows(SynthesisCancelledException::class.java) {
            broker.begin(requestKey, "Llegó tarde")
        }
        assertTrue(broker.activeRequest() == null)
        assertEquals("unrelated", broker.begin(key("unrelated"), "Siguiente").key.requestId)
    }

    @Test
    fun onlyOneSynthesisCanBeActiveAndTerminalIsExactlyOnce(): Unit = runBlocking {
        val broker = broker()
        val first = broker.begin(key("first"), "Hola")

        assertThrows(SynthesisBusyException::class.java) {
            broker.begin(key("second"), "Adiós")
        }

        first.outputFile.writeBytes(pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2, 3)))
        assertTrue(
            broker.finishSuccess(
                first,
                enginePackage = "org.example.tts",
                engineVersion = "1.2.3:12",
                maxInputLength = 4_000,
            ),
        )
        assertFalse(broker.finishError(first, "late callback"))

        val terminal = first.terminal.await()
        assertTrue(terminal is SynthesisTerminal.Ready)
        assertEquals("first-again", broker.begin(key("first-again"), "Otra").key.requestId)
    }

    @Test
    fun cancellationDiscardsLateSuccessAndLeavesBrokerReusable(): Unit = runBlocking {
        val broker = broker()
        val active = broker.begin(key("cancel-me"), "Texto")
        active.outputFile.writeBytes(pcm16Wav(sampleRate = 22_050, samples = shortArrayOf(1, 2)))

        assertEquals(active, broker.requestCancel(key("cancel-me")))
        assertTrue(
            broker.finishSuccess(
                active,
                enginePackage = "org.example.tts",
                engineVersion = "1:1",
                maxInputLength = 4_000,
            ),
        )

        assertEquals(SynthesisTerminal.Cancelled, active.terminal.await())
        assertFalse(active.outputFile.exists())
        assertEquals("next", broker.begin(key("next"), "Siguiente").key.requestId)
    }

    @Test
    fun validWavMetadataAndRangesAreReturnedAndReadDeletesAsset(): Unit = runBlocking {
        val broker = broker()
        val active = broker.begin(key("ready"), "A😀B")
        val wav = pcm16Wav(sampleRate = 10, samples = ShortArray(20) { it.toShort() })
        active.outputFile.writeBytes(wav)
        broker.addRange(active.utteranceId, RawSynthesisRange(start = 0, end = 1, frame = 0))
        broker.addRange(active.utteranceId, RawSynthesisRange(start = 1, end = 3, frame = 5))
        broker.addRange(active.utteranceId, RawSynthesisRange(start = 3, end = 4, frame = 10))

        assertTrue(
            broker.finishSuccess(
                active,
                enginePackage = "org.example.tts",
                engineVersion = "2:9",
                maxInputLength = 5_000,
            ),
        )

        val ready = (active.terminal.await() as SynthesisTerminal.Ready).asset
        assertEquals(10, ready.sampleRate)
        assertEquals(20L, ready.frameCount)
        assertEquals(2.0, ready.durationSec, 0.000_001)
        assertEquals(
            listOf(
                RawSynthesisRange(0, 1, 0),
                RawSynthesisRange(1, 3, 5),
                RawSynthesisRange(3, 4, 10),
            ),
            ready.ranges,
        )

        assertArrayEquals(wav, broker.readAndDelete(ready.assetId))
        assertFalse(active.outputFile.exists())
        assertThrows(UnknownSynthesisAssetException::class.java) {
            broker.readAndDelete(ready.assetId)
        }
    }

    @Test
    fun invalidWavFailsAndDeletesTemporaryFile(): Unit = runBlocking {
        val broker = broker()
        val active = broker.begin(key("invalid-wav"), "Texto")
        active.outputFile.writeText("not a wave file")

        assertTrue(
            broker.finishSuccess(
                active,
                enginePackage = "org.example.tts",
                engineVersion = "1:1",
                maxInputLength = 4_000,
            ),
        )

        assertTrue(active.terminal.await() is SynthesisTerminal.Failed)
        assertFalse(active.outputFile.exists())
    }

    @Test
    fun cancellationAfterReadyDeletesAssetBeforeItIsRead(): Unit = runBlocking {
        val broker = broker()
        val requestKey = key("ready-then-cancel")
        val active = broker.begin(requestKey, "Texto")
        active.outputFile.writeBytes(pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2)))
        broker.finishSuccess(
            active,
            enginePackage = "org.example.tts",
            engineVersion = "1:1",
            maxInputLength = 4_000,
        )
        val asset = (active.terminal.await() as SynthesisTerminal.Ready).asset

        assertEquals(null, broker.requestCancel(requestKey))
        assertFalse(active.outputFile.exists())
        assertEquals(null, broker.requestCancel(requestKey))
        assertThrows(UnknownSynthesisAssetException::class.java) {
            broker.readAndDelete(asset.assetId)
        }
        assertEquals("after-cancel", broker.begin(key("after-cancel"), "Siguiente").key.requestId)
    }

    @Test
    fun finalReadyDiscardClosesCancelRaceWithTerminalCallback(): Unit = runBlocking {
        val broker = broker()
        val requestKey = key("cancel-race")
        val capturedActive = broker.begin(requestKey, "Texto")
        capturedActive.outputFile.writeBytes(
            pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2)),
        )

        // Models cancel reading the active request immediately before onDone wins.
        broker.finishSuccess(
            capturedActive,
            enginePackage = "org.example.tts",
            engineVersion = "1:1",
            maxInputLength = 4_000,
        )
        capturedActive.cancelRequested.set(true)
        val asset = (capturedActive.terminal.await() as SynthesisTerminal.Ready).asset

        broker.discardReady(requestKey)
        assertFalse(capturedActive.outputFile.exists())
        assertThrows(UnknownSynthesisAssetException::class.java) {
            broker.readAndDelete(asset.assetId)
        }
    }

    @Test
    fun anyInvalidRangeFallsBackToNoRanges(): Unit = runBlocking {
        val broker = broker()
        val active = broker.begin(key("invalid-range"), "A😀B")
        active.outputFile.writeBytes(pcm16Wav(sampleRate = 10, samples = ShortArray(20)))
        broker.addRange(active.utteranceId, RawSynthesisRange(start = 0, end = 1, frame = 0))
        // Splits the UTF-16 surrogate pair for the emoji.
        broker.addRange(active.utteranceId, RawSynthesisRange(start = 1, end = 2, frame = 5))

        broker.finishSuccess(
            active,
            enginePackage = "org.example.tts",
            engineVersion = "1:1",
            maxInputLength = 4_000,
        )

        val ready = (active.terminal.await() as SynthesisTerminal.Ready).asset
        assertTrue(ready.ranges.isEmpty())
    }

    @Test
    fun nonMonotonicOrOutOfBoundsRangesFallBackToNoRanges() {
        assertTrue(
            validateSynthesisRanges(
                text = "hola",
                frameCount = 100,
                ranges = listOf(
                    RawSynthesisRange(0, 2, 20),
                    RawSynthesisRange(2, 4, 10),
                ),
            ).isEmpty(),
        )
        assertTrue(
            validateSynthesisRanges(
                text = "hola",
                frameCount = 100,
                ranges = listOf(
                    RawSynthesisRange(0, 2, 10),
                    RawSynthesisRange(2, 4, 10),
                ),
            ).isEmpty(),
        )
        assertTrue(
            validateSynthesisRanges(
                text = "hola",
                frameCount = 100,
                ranges = listOf(RawSynthesisRange(0, 5, 0)),
            ).isEmpty(),
        )
    }

    @Test
    fun wavMustBeExactMonoPcm16WithoutTrailingBytes() {
        val stereo = pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2)).copyOf()
        writeLittleEndianShort(stereo, offset = 22, value = 2)
        writeLittleEndianInt(stereo, offset = 28, value = 16_000 * 4)
        writeLittleEndianShort(stereo, offset = 32, value = 4)
        assertThrows(IllegalArgumentException::class.java) { parsePcmWav(stereo) }

        val invalidByteRate = pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2)).copyOf()
        writeLittleEndianInt(invalidByteRate, offset = 28, value = 123)
        assertThrows(IllegalArgumentException::class.java) { parsePcmWav(invalidByteRate) }

        val withTrailingByte = pcm16Wav(sampleRate = 16_000, samples = shortArrayOf(1, 2)) + 0
        assertThrows(IllegalArgumentException::class.java) { parsePcmWav(withTrailingByte) }
    }

    @Test
    fun startupCleanupOnlyRemovesFilesOwnedByBrokerDirectory() {
        val cacheRoot = temporaryFolder.newFolder("cache")
        val brokerDirectory = File(cacheRoot, "native-tts-synthesis").apply { mkdirs() }
        File(brokerDirectory, "orphan.wav").writeBytes(byteArrayOf(1))
        val unrelated = File(cacheRoot, "keep.txt").apply { writeText("keep") }

        FileSynthesisBroker(brokerDirectory)

        assertTrue(brokerDirectory.listFiles().orEmpty().isEmpty())
        assertTrue(unrelated.exists())
    }

    private fun broker(): FileSynthesisBroker =
        FileSynthesisBroker(temporaryFolder.newFolder("broker-${System.nanoTime()}"))

    private fun key(requestId: String) =
        SynthesisRequestKey(sessionId = "session", requestId = requestId, generation = 7)

    private fun pcm16Wav(sampleRate: Int, samples: ShortArray): ByteArray {
        val pcm = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach(pcm::putShort)
        val data = pcm.array()
        val out = ByteArrayOutputStream()
        out.write("RIFF".toByteArray(Charsets.US_ASCII))
        out.write(littleEndianInt(36 + data.size))
        out.write("WAVE".toByteArray(Charsets.US_ASCII))
        out.write("fmt ".toByteArray(Charsets.US_ASCII))
        out.write(littleEndianInt(16))
        out.write(littleEndianShort(1))
        out.write(littleEndianShort(1))
        out.write(littleEndianInt(sampleRate))
        out.write(littleEndianInt(sampleRate * 2))
        out.write(littleEndianShort(2))
        out.write(littleEndianShort(16))
        out.write("data".toByteArray(Charsets.US_ASCII))
        out.write(littleEndianInt(data.size))
        out.write(data)
        return out.toByteArray()
    }

    private fun littleEndianInt(value: Int): ByteArray =
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()

    private fun littleEndianShort(value: Int): ByteArray =
        ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort()).array()

    private fun writeLittleEndianInt(bytes: ByteArray, offset: Int, value: Int) {
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putInt(offset, value)
    }

    private fun writeLittleEndianShort(bytes: ByteArray, offset: Int, value: Int) {
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).putShort(offset, value.toShort())
    }
}
