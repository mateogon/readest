package com.readest.native_tts

import android.Manifest
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.app.Activity
import android.content.Context
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginResult
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.*
import java.net.URL

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

data class TTSVoiceData(
    val id: String,
    val name: String,
    val lang: String,
    val disabled: Boolean = false
)

data class TTSMessageEvent(
    val code: String, // 'boundary' | 'error' | 'end'
    val message: String? = null,
    val mark: String? = null
)

@InvokeArg
class SpeakArgs(
    val text: String? = "",
    val preload: Boolean? = false
)

@InvokeArg
class SetRateArgs(
    val rate: Float? = 1.0f
)

@InvokeArg
class SetPitchArgs(
    val pitch: Float? = 1.0f
)

@InvokeArg
class SetVoiceArgs(
    val voice: String? = null
)

@InvokeArg
class SynthesizeToFileArgs(
    val text: String? = null,
    val enginePackage: String? = null,
    val voice: String? = null,
    val locale: String? = null,
    val pitch: Float? = null,
    val rate: Float? = null,
    val sessionId: String? = null,
    val requestId: String? = null,
    val generation: Long? = null,
)

@InvokeArg
class ReadSynthesisAudioArgs(
    val assetId: String? = null,
)

@InvokeArg
class CancelSynthesisArgs(
    val sessionId: String? = null,
    val requestId: String? = null,
    val generation: Long? = null,
)

private data class EngineMetadata(
    val packageName: String,
    val version: String,
    val maxInputLength: Int,
)

private data class ValidatedSynthesisArgs(
    val text: String,
    val enginePackage: String,
    val voice: String,
    val locale: String,
    val pitch: Float,
    val sessionId: String,
    val requestId: String,
    val generation: Long,
)

@InvokeArg
class UpdateMediaSessionMetadataArgs {
  var title: String? = null
  var artist: String? = null
  var album: String? = null
  var artwork: String? = null
}

@InvokeArg
class UpdateMediaSessionStateArgs {
  var playing: Boolean? = null
  var position: Int? = null // in milliseconds
  var duration: Int? = null // in milliseconds
}

@InvokeArg
class SetMediaSessionActiveArgs {
  var active: Boolean? = null
  var notificationTitle: String? = null
  var notificationText: String? = null
  var foregroundServiceTitle: String? = null
  var foregroundServiceText: String? = null
  var bookHash: String? = null
  var bookTitle: String? = null
  var bookAuthor: String? = null
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "postNotification")
  ]
)
class NativeTTSPlugin(private val activity: Activity) : Plugin(activity) {
    
    companion object {
        private const val TAG = "NativeTTSPlugin"
        private const val CHANNEL_NAME = "tts_events"
        private const val IDLE_TIMEOUT_MS = 30L * 60 * 1000 // 30 minutes
        private const val SYNTHESIS_CANCEL_TIMEOUT_MS = 5_000L
        var NOTIFICATION_TITLE = "Read Aloud"
        var NOTIFICATION_TEXT = "Ready to read aloud"
        var FOREGROUND_SERVICE_TITLE = "Read Aloud"
        var FOREGROUND_SERVICE_TEXT = "Ready to read aloud"
    }

    private var textToSpeech: TextToSpeech? = null
    private var isInitialized = AtomicBoolean(false)
    private var isPaused = AtomicBoolean(false)
    private var isSpeaking = AtomicBoolean(false)
    private var currentRate = AtomicReference<Float>(1.0f)
    private var currentPitch = AtomicReference<Float>(1.0f)
    private var initializedEnginePackage: String? = null

    private val initializationMutex = Mutex()
    private val operationGate = NativeTtsOperationGate()
    private val synthesisBroker by lazy {
        FileSynthesisBroker(File(activity.cacheDir, "native-tts-synthesis"))
    }

    private val eventChannels = ConcurrentHashMap<String, Channel<TTSMessageEvent>>()
    private val speakingJobs = ConcurrentHashMap<String, Job>()
    private val coroutineScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val idleHandler = Handler(Looper.getMainLooper())
    private val idleShutdownRunnable = Runnable {
        Log.d(TAG, "Idle timeout reached, shutting down TTS engine to save battery")
        shutdownTTSEngine()
    }

    @Command
    fun init(invoke: Invoke) {
        cancelIdleTimer()
        coroutineScope.launch {
            try {
                // Constructing the broker also sweeps assets left by a previous process.
                synthesisBroker
                val success = initializeTTS()
                val result = JSObject().apply {
                    put("success", success)
                    if (success) {
                        currentEngineMetadata()?.let { metadata ->
                            put("enginePackage", metadata.packageName)
                            put("engineVersion", metadata.version)
                            put("maxInputLength", metadata.maxInputLength)
                        }
                    }
                }
                invoke.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initialize TTS", e)
                invoke.reject("Failed to initialize TTS: ${e.message}")
            }
        }
    }
    
    private suspend fun initializeTTS(): Boolean = initializationMutex.withLock {
        val preferredEngine = preferredEnginePackage()
        if (
            isInitialized.get() &&
                textToSpeech != null &&
                (preferredEngine == null || preferredEngine == initializedEnginePackage)
        ) {
            return@withLock true
        }
        if (!operationGate.isIdle()) return@withLock false
        textToSpeech?.shutdown()
        textToSpeech = null
        initializedEnginePackage = null
        isInitialized.set(false)
        initializeTTSLocked(preferredEngine)
    }

    private fun preferredEnginePackage(): String? =
        Settings.Secure.getString(
            activity.contentResolver,
            Settings.Secure.TTS_DEFAULT_SYNTH,
        )

    private suspend fun initializeTTSLocked(
        preferredEngine: String? = preferredEnginePackage(),
    ): Boolean = suspendCancellableCoroutine { continuation ->
        try {
            textToSpeech = TextToSpeech(activity, { status ->
                when (status) {
                    TextToSpeech.SUCCESS -> {
                        initializedEnginePackage = textToSpeech?.defaultEngine ?: preferredEngine
                        setupTTSListener()
                        isInitialized.set(true)
                        if (continuation.isActive) {
                            @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
                            continuation.resume(true) {}
                        }
                    }
                    else -> {
                        Log.e(TAG, "TTS initialization failed with status: $status")
                        textToSpeech?.shutdown()
                        textToSpeech = null
                        initializedEnginePackage = null
                        isInitialized.set(false)
                        if (continuation.isActive) {
                            @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
                            continuation.resume(false) {}
                        }
                    }
                }
            }, preferredEngine)
        } catch (e: Exception) {
            Log.e(TAG, "Exception during TTS initialization", e)
            textToSpeech?.shutdown()
            textToSpeech = null
            initializedEnginePackage = null
            isInitialized.set(false)
            if (continuation.isActive) {
                @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
                continuation.resume(false) {}
            }
        }
    }

    private fun currentEngineMetadata(): EngineMetadata? {
        val packageName = initializedEnginePackage ?: textToSpeech?.defaultEngine ?: return null
        return try {
            val packageInfo = activity.packageManager.getPackageInfo(packageName, 0)
            @Suppress("DEPRECATION")
            val versionCode =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    packageInfo.longVersionCode
                } else {
                    packageInfo.versionCode.toLong()
                }
            EngineMetadata(
                packageName = packageName,
                version = "${packageInfo.versionName ?: "unknown"}:$versionCode",
                maxInputLength = TextToSpeech.getMaxSpeechInputLength(),
            )
        } catch (error: Exception) {
            Log.e(TAG, "Unable to resolve TTS engine metadata", error)
            null
        }
    }

    private fun markEngineDisconnected() {
        textToSpeech?.shutdown()
        textToSpeech = null
        initializedEnginePackage = null
        isInitialized.set(false)
        isSpeaking.set(false)
    }
    
    private fun setupTTSListener() {
        textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                utteranceId?.let { id ->
                    isSpeaking.set(true)
                    if (synthesisBroker.activeForUtterance(id) != null) return
                    sendEvent(id, TTSMessageEvent("boundary", "start"))
                }
            }
            
            override fun onDone(utteranceId: String?) {
                utteranceId?.let { id ->
                    isSpeaking.set(false)
                    val synthesis = synthesisBroker.activeForUtterance(id)
                    if (synthesis != null) {
                        val metadata = currentEngineMetadata()
                        coroutineScope.launch(Dispatchers.IO) {
                            if (metadata == null) {
                                synthesisBroker.finishError(synthesis, "TTS engine identity is unavailable")
                            } else {
                                synthesisBroker.finishSuccess(
                                    synthesis,
                                    metadata.packageName,
                                    metadata.version,
                                    metadata.maxInputLength,
                                )
                            }
                        }
                        return
                    }
                    operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, id)
                    sendEvent(id, TTSMessageEvent("end"))
                    closeEventChannel(id)
                }
            }

            @Deprecated("deprecated in API level 21")
            override fun onError(utteranceId: String?) {
                utteranceId?.let { id ->
                    isSpeaking.set(false)
                    val synthesis = synthesisBroker.activeForUtterance(id)
                    if (synthesis != null) {
                        synthesisBroker.finishError(synthesis, "TTS file synthesis error")
                        return
                    }
                    operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, id)
                    sendEvent(id, TTSMessageEvent("error", "TTS playback error"))
                    closeEventChannel(id)
                }
            }
            
            override fun onError(utteranceId: String?, errorCode: Int) {
                utteranceId?.let { id ->
                    isSpeaking.set(false)
                    val synthesis = synthesisBroker.activeForUtterance(id)
                    if (synthesis != null) {
                        if (errorCode == TextToSpeech.ERROR_SERVICE) {
                            coroutineScope.launch {
                                markEngineDisconnected()
                                synthesisBroker.finishError(synthesis, "TTS engine disconnected")
                            }
                        } else {
                            synthesisBroker.finishError(synthesis, "TTS file synthesis error:$errorCode")
                        }
                        return
                    }
                    operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, id)
                    if (errorCode == TextToSpeech.ERROR_SERVICE) markEngineDisconnected()
                    sendEvent(id, TTSMessageEvent("error", "TTS playback error:$errorCode"))
                    closeEventChannel(id)
                }
            }

            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                utteranceId?.let { id ->
                    isSpeaking.set(false)
                    val synthesis = synthesisBroker.activeForUtterance(id)
                    if (synthesis != null) {
                        if (synthesis.cancelRequested.get()) {
                            synthesisBroker.finishCancelled(synthesis)
                        } else {
                            synthesisBroker.finishError(synthesis, "TTS file synthesis stopped")
                        }
                    } else {
                        operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, id)
                    }
                }
            }
            
            override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
                utteranceId?.let { id ->
                    val synthesis = synthesisBroker.activeForUtterance(id)
                    if (synthesis != null) {
                        synthesisBroker.addRange(id, RawSynthesisRange(start, end, frame.toLong()))
                        return
                    }
                    sendEvent(id, TTSMessageEvent("boundary", "range", "pos:$start-$end"))
                }
            }
        })
    }
    
    @Command
    fun speak(invoke: Invoke) {
        cancelIdleTimer()

        val args = invoke.parseArgs(SpeakArgs::class.java)
        val text = args.text ?: ""

        if (text.isEmpty()) {
            invoke.reject("Text cannot be empty")
            return
        }

        val utteranceId = UUID.randomUUID().toString()

        coroutineScope.launch {
            var claim: NativeTtsOperationClaim? = null
            try {
                // Re-initialize TTS engine if it was shut down by the idle timer
                if (!isInitialized.get()) {
                    val success = initializeTTS()
                    if (!success) {
                        invoke.reject("Failed to re-initialize TTS engine")
                        return@launch
                    }
                    Log.d(TAG, "TTS engine re-initialized after idle shutdown")
                }
                claim =
                    operationGate.tryAcquire(NativeTtsOperationKind.DIRECT_SPEAK, utteranceId)
                        ?: run {
                            invoke.reject("Another native TTS operation is active")
                            return@launch
                        }

                val eventChannel = Channel<TTSMessageEvent>(Channel.UNLIMITED)
                eventChannels[utteranceId] = eventChannel

                val speakJob = launch {
                    speakText(text, utteranceId, args.preload ?: false)
                }
                speakingJobs[utteranceId] = speakJob

                val result = JSObject().apply {
                    put("utteranceId", utteranceId)
                }
                invoke.resolve(result)

                // Start sending events to the frontend
                startEventStream(utteranceId)

            } catch (e: Exception) {
                claim?.let(operationGate::release)
                Log.e(TAG, "Failed to start speaking", e)
                invoke.reject("Failed to start speaking: ${e.message}")
            }
        }
    }
    
    private suspend fun speakText(text: String, utteranceId: String, preload: Boolean) {
        withContext(Dispatchers.Main) {
            try {
                textToSpeech?.apply {
                    setSpeechRate(currentRate.get())
                    setPitch(currentPitch.get())
                }
                
                val params = Bundle().apply {
                    putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
                }
                
                val result = textToSpeech?.speak(
                    text,
                    if (preload) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH,
                    params,
                    utteranceId
                )
                
                if (result != TextToSpeech.SUCCESS) {
                    operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, utteranceId)
                    sendEvent(utteranceId, TTSMessageEvent("error", "Failed to start speech"))
                    closeEventChannel(utteranceId)
                }
            } catch (e: Exception) {
                operationGate.release(NativeTtsOperationKind.DIRECT_SPEAK, utteranceId)
                sendEvent(utteranceId, TTSMessageEvent("error", "Exception during speech: ${e.message}"))
                closeEventChannel(utteranceId)
            }
        }
    }
    
    private fun startEventStream(utteranceId: String) {
        coroutineScope.launch {
            val channel = eventChannels[utteranceId] ?: return@launch
            try {
                for (event in channel) {
                    val eventData = JSObject().apply {
                        put("utteranceId", utteranceId)
                        put("code", event.code)
                        event.message?.let { put("message", it) }
                        event.mark?.let { put("mark", it) }
                    }
                    trigger(CHANNEL_NAME, eventData)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error in event stream for $utteranceId", e)
            }
        }
    }
    
    private fun sendEvent(utteranceId: String, event: TTSMessageEvent) {
        coroutineScope.launch {
            eventChannels[utteranceId]?.trySend(event)
        }
    }
    
    private fun closeEventChannel(utteranceId: String) {
        coroutineScope.launch {
            eventChannels[utteranceId]?.close()
            eventChannels.remove(utteranceId)
            speakingJobs[utteranceId]?.cancel()
            speakingJobs.remove(utteranceId)
        }
    }
    
    @Command
    fun pause(invoke: Invoke) {
        try {
            val activeOperation = operationGate.activeClaim()
            if (activeOperation?.kind == NativeTtsOperationKind.FILE_SYNTHESIS) {
                invoke.reject("Cannot pause direct speech while file synthesis is active")
                return
            }
            if (textToSpeech?.stop() == TextToSpeech.SUCCESS) {
                activeOperation?.takeIf { it.kind == NativeTtsOperationKind.DIRECT_SPEAK }
                    ?.let(operationGate::release)
                isPaused.set(true)
                startIdleTimer()
                invoke.resolve()
            } else {
                invoke.reject("Failed to pause TTS")
            }
        } catch (e: Exception) {
            invoke.reject("Exception while pausing: ${e.message}")
        }
    }
    
    @Command
    fun resume(invoke: Invoke) {
        cancelIdleTimer()
        try {
            isPaused.set(false)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Exception while resuming: ${e.message}")
        }
    }
    
    @Command
    fun stop(invoke: Invoke) {
        try {
            val activeOperation = operationGate.activeClaim()
            synthesisBroker.activeRequest()?.cancelRequested?.set(true)
            if (textToSpeech?.stop() == TextToSpeech.SUCCESS) {
                activeOperation?.takeIf { it.kind == NativeTtsOperationKind.DIRECT_SPEAK }
                    ?.let(operationGate::release)
                isSpeaking.set(false)
                isPaused.set(false)
                speakingJobs.values.forEach { it.cancel() }
                eventChannels.values.forEach { it.close() }
                speakingJobs.clear()
                eventChannels.clear()
                startIdleTimer()

                invoke.resolve()
            } else {
                invoke.reject("Failed to stop TTS")
            }
        } catch (e: Exception) {
            invoke.reject("Exception while stopping: ${e.message}")
        }
    }
    
    @Command
    fun set_rate(invoke: Invoke) {
        val args = invoke.parseArgs(SetRateArgs::class.java)
        var claim: NativeTtsOperationClaim? = null
        try {
            claim =
                operationGate.tryAcquire(NativeTtsOperationKind.CONFIGURATION, "set-rate")
                    ?: run {
                        invoke.reject("Another native TTS operation is active")
                        return
                    }
            currentRate.set(args.rate ?: 1.0f)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Exception setting rate: ${e.message}")
        } finally {
            claim?.let(operationGate::release)
        }
    }
    
    @Command
    fun set_pitch(invoke: Invoke) {
        val args = invoke.parseArgs(SetPitchArgs::class.java)
        var claim: NativeTtsOperationClaim? = null
        try {
            claim =
                operationGate.tryAcquire(NativeTtsOperationKind.CONFIGURATION, "set-pitch")
                    ?: run {
                        invoke.reject("Another native TTS operation is active")
                        return
                    }
            currentPitch.set(args.pitch ?: 1.0f)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Exception setting pitch: ${e.message}")
        } finally {
            claim?.let(operationGate::release)
        }
    }

    @Command
    fun set_voice(invoke: Invoke) {
        val args = invoke.parseArgs(SetVoiceArgs::class.java)
        coroutineScope.launch {
            var claim: NativeTtsOperationClaim? = null
            try {
                if (!isInitialized.get()) {
                    initializeTTS()
                }
                claim =
                    operationGate.tryAcquire(NativeTtsOperationKind.CONFIGURATION, "set-voice")
                        ?: run {
                            invoke.reject("Another native TTS operation is active")
                            return@launch
                        }
                val targetVoice = findVoice(args.voice)

                if (targetVoice != null) {
                    val result = textToSpeech?.setVoice(targetVoice)
                    if (result == TextToSpeech.SUCCESS) {
                        invoke.resolve()
                    } else {
                        invoke.reject("Failed to set voice: ${args.voice}")
                    }
                } else {
                    invoke.reject("Voice not found: ${args.voice}")
                }
            } catch (e: Exception) {
                invoke.reject("Exception setting voice: ${e.message}")
            } finally {
                claim?.let(operationGate::release)
            }
        }
    }
    
    @Command
    fun get_all_voices(invoke: Invoke) {
        coroutineScope.launch {
            try {
                if (!isInitialized.get()) {
                    initializeTTS()
                }
                val voices = textToSpeech?.voices?.map { voice ->
                    val voiceName = voice.name
                    val language = voice.locale.toLanguageTag()
                    val (id, name) = if (language.contains(voiceName)) {
                        language to language
                    } else {
                        voiceName to voiceName
                    }
                    JSObject().apply {
                        put("id", id)
                        put("name", name)
                        put("lang", language)
                        put("disabled", false)
                    }
                } ?: emptyList()

                val result = JSObject().apply {
                    put("voices", JSONArray(voices))
                }
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject("Exception getting voices: ${e.message}")
            }
        }
    }

    @Command
    fun synthesize_to_file(invoke: Invoke) {
        cancelIdleTimer()
        val rawArgs = invoke.parseArgs(SynthesizeToFileArgs::class.java)
        coroutineScope.launch {
            var active: ActiveFileSynthesis? = null
            var claim: NativeTtsOperationClaim? = null
            try {
                val args = validateSynthesisArgs(rawArgs)
                if (!initializeTTS()) {
                    invoke.reject("Failed to initialize the TTS engine")
                    return@launch
                }
                val metadata =
                    currentEngineMetadata()
                        ?: throw IllegalStateException("TTS engine identity is unavailable")
                require(args.enginePackage == metadata.packageName) {
                    "Requested TTS engine does not match the initialized engine"
                }
                require(args.text.length <= metadata.maxInputLength) {
                    "Text exceeds Android TTS input limit (${metadata.maxInputLength})"
                }
                val requestKey =
                    SynthesisRequestKey(args.sessionId, args.requestId, args.generation)
                claim =
                    operationGate.tryAcquire(
                        NativeTtsOperationKind.FILE_SYNTHESIS,
                        synthesisClaimId(requestKey),
                    )
                        ?: throw SynthesisBusyException()
                val tts = textToSpeech ?: throw IllegalStateException("TTS engine is unavailable")
                val request =
                    synthesisBroker.begin(
                        requestKey,
                        args.text,
                    )
                active = request
                configureFileSynthesis(tts, args)
                val params = Bundle().apply {
                    putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, request.utteranceId)
                }
                val startResult =
                    tts.synthesizeToFile(args.text, params, request.outputFile, request.utteranceId)
                if (startResult != TextToSpeech.SUCCESS) {
                    markEngineDisconnected()
                    synthesisBroker.finishError(request, "TTS engine disconnected")
                }

                when (val terminal = request.terminal.await()) {
                    is SynthesisTerminal.Ready -> invoke.resolve(synthesisAssetToJs(terminal.asset))
                    is SynthesisTerminal.Failed -> invoke.reject(terminal.message)
                    SynthesisTerminal.Cancelled -> invoke.reject("TTS file synthesis cancelled")
                }
            } catch (error: Exception) {
                active?.let { synthesisBroker.finishError(it, error.message ?: "TTS file synthesis failed") }
                Log.e(TAG, "TTS file synthesis failed", error)
                invoke.reject(error.message ?: "TTS file synthesis failed")
            } finally {
                claim?.let(operationGate::release)
            }
        }
    }

    @Command
    fun read_synthesis_audio(invoke: Invoke) {
        val args = invoke.parseArgs(ReadSynthesisAudioArgs::class.java)
        coroutineScope.launch {
            try {
                val assetId = args.assetId?.takeIf { it.isNotBlank() }
                    ?: throw IllegalArgumentException("assetId must not be empty")
                val audio = withContext(Dispatchers.IO) { synthesisBroker.readAndDelete(assetId) }
                invoke.resolve(
                    JSObject().apply {
                        put("data", Base64.encodeToString(audio, Base64.NO_WRAP))
                    },
                )
            } catch (error: Exception) {
                invoke.reject(error.message ?: "Failed to read synthesis audio")
            }
        }
    }

    @Command
    fun cancel_synthesis(invoke: Invoke) {
        val args = invoke.parseArgs(CancelSynthesisArgs::class.java)
        coroutineScope.launch {
            var requestKey: SynthesisRequestKey? = null
            try {
                val key = validateCancelArgs(args)
                requestKey = key
                val fileClaim =
                    operationGate.activeClaim()?.takeIf {
                        it.kind == NativeTtsOperationKind.FILE_SYNTHESIS &&
                            it.id == synthesisClaimId(key)
                    }
                val active = synthesisBroker.requestCancel(key)
                var engineWasReset = false
                if (active != null) {
                    val stopResult = textToSpeech?.stop()
                    val terminal =
                        if (stopResult == TextToSpeech.SUCCESS) {
                            withTimeoutOrNull(SYNTHESIS_CANCEL_TIMEOUT_MS) { active.terminal.await() }
                        } else {
                            null
                        }
                    if (terminal == null) {
                        synthesisBroker.finishCancelled(active)
                        if (!resetTTSEngine()) {
                            invoke.reject("TTS engine could not be reset after cancellation")
                            return@launch
                        }
                        engineWasReset = true
                    }
                }

                if (fileClaim != null) {
                    val released =
                        withTimeoutOrNull(SYNTHESIS_CANCEL_TIMEOUT_MS) {
                            fileClaim.released.await()
                            true
                        } ?: false
                    if (!released) {
                        if (!engineWasReset && !resetTTSEngine()) {
                            invoke.reject("TTS engine did not become reusable after cancellation")
                            return@launch
                        }
                        operationGate.release(fileClaim)
                    }
                }
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject(error.message ?: "Failed to cancel synthesis")
            } finally {
                // onDone can win between requestCancel reading active and setting its flag.
                // Cleanup must also survive a failed engine reset.
                requestKey?.let(synthesisBroker::discardReady)
            }
        }
    }

    private fun validateSynthesisArgs(args: SynthesizeToFileArgs): ValidatedSynthesisArgs {
        fun required(name: String, value: String?): String =
            value?.takeIf { it.isNotBlank() }
                ?: throw IllegalArgumentException("$name must not be empty")

        val pitch = args.pitch ?: throw IllegalArgumentException("pitch is required")
        val rate = args.rate ?: throw IllegalArgumentException("rate is required")
        require(pitch.isFinite() && pitch > 0.0f) { "pitch must be finite and greater than zero" }
        require(rate.isFinite() && rate == 1.0f) { "synthesis rate must be exactly 1.0" }
        val generation = args.generation ?: throw IllegalArgumentException("generation is required")
        require(generation >= 0) { "generation must not be negative" }
        return ValidatedSynthesisArgs(
            text = required("text", args.text),
            enginePackage = required("enginePackage", args.enginePackage),
            voice = required("voice", args.voice),
            locale = required("locale", args.locale),
            pitch = pitch,
            sessionId = required("sessionId", args.sessionId),
            requestId = required("requestId", args.requestId),
            generation = generation,
        )
    }

    private fun validateCancelArgs(args: CancelSynthesisArgs): SynthesisRequestKey {
        val sessionId = args.sessionId?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("sessionId must not be empty")
        val requestId = args.requestId?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("requestId must not be empty")
        val generation = args.generation ?: throw IllegalArgumentException("generation is required")
        require(generation >= 0) { "generation must not be negative" }
        return SynthesisRequestKey(sessionId, requestId, generation)
    }

    private fun synthesisClaimId(key: SynthesisRequestKey): String =
        "${key.sessionId}:${key.requestId}:${key.generation}"

    private fun configureFileSynthesis(tts: TextToSpeech, args: ValidatedSynthesisArgs) {
        val locale = Locale.forLanguageTag(args.locale.replace('_', '-'))
        require(locale.language.isNotBlank()) { "locale is invalid" }
        val languageResult = tts.setLanguage(locale)
        require(
            languageResult != TextToSpeech.LANG_MISSING_DATA &&
                languageResult != TextToSpeech.LANG_NOT_SUPPORTED,
        ) { "locale is not supported by the initialized TTS engine" }
        val voice = findVoice(args.voice) ?: throw IllegalArgumentException("Voice not found: ${args.voice}")
        require(tts.setVoice(voice) == TextToSpeech.SUCCESS) { "Failed to set voice: ${args.voice}" }
        require(tts.setPitch(args.pitch) == TextToSpeech.SUCCESS) { "Failed to set synthesis pitch" }
        require(tts.setSpeechRate(1.0f) == TextToSpeech.SUCCESS) {
            "Failed to force synthesis rate to 1.0"
        }
    }

    private fun findVoice(voiceId: String?): Voice? =
        textToSpeech?.voices?.find { voice ->
            val languageTag = voice.locale.toLanguageTag()
            voice.name == voiceId || (languageTag.contains(voice.name) && languageTag == voiceId)
        }

    private fun synthesisAssetToJs(asset: SynthesisAsset): JSObject =
        JSObject().apply {
            put("assetId", asset.assetId)
            put("sampleRate", asset.sampleRate)
            put("frameCount", asset.frameCount)
            put("durationSec", asset.durationSec)
            put("enginePackage", asset.enginePackage)
            put("engineVersion", asset.engineVersion)
            put("maxInputLength", asset.maxInputLength)
            put(
                "ranges",
                JSONArray(
                    asset.ranges.map { range ->
                        JSObject().apply {
                            put("start", range.start)
                            put("end", range.end)
                            put("frame", range.frame)
                        }
                    },
                ),
            )
        }

    private suspend fun resetTTSEngine(): Boolean = initializationMutex.withLock {
        textToSpeech?.shutdown()
        textToSpeech = null
        initializedEnginePackage = null
        isInitialized.set(false)
        isSpeaking.set(false)
        initializeTTSLocked()
    }

    private suspend fun loadArtworkFromUrl(urlString: String): Bitmap? {
        return withContext(Dispatchers.IO) {
            try {
                when {
                    urlString.startsWith("data:image/") -> {
                        val base64Data = urlString.substringAfter("base64,")
                        val decodedBytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT)
                        BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                    }
                    urlString.startsWith("http") -> {
                        val url = URL(urlString)
                        val input: java.io.InputStream = url.openStream()
                        BitmapFactory.decodeStream(input)
                    }
                    else -> {
                        val assetPath = urlString.removePrefix("/")
                        val inputStream = activity.assets.open(assetPath)
                        BitmapFactory.decodeStream(inputStream)
                    }
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    @Command
    fun update_media_session_metadata(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateMediaSessionMetadataArgs::class.java)
        val title = args.title ?: ""
        val artist = args.artist ?: ""

        coroutineScope.launch {
            try {
                val artworkBitmap = args.artwork?.let { loadArtworkFromUrl(it) }
                // In-process update on the running service; never startService()
                // — that throws "app is in background" once backgrounded.
                MediaPlaybackService.pushMetadata(title, artist, artworkBitmap)
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("Failed to update metadata: ${e.message}")
            }
        }
    }

    @Command
    fun update_media_session_state(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateMediaSessionStateArgs::class.java)
        val isPlaying = args.playing ?: false

        try {
            // In-process update on the running service; never startService()
            // — that throws "app is in background" once backgrounded. position
            // and duration are null on a bare play/pause flip; the service
            // keeps the last known values so the scrubber does not reset.
            MediaPlaybackService.pushPlaybackState(
                isPlaying,
                args.position?.toLong(),
                args.duration?.toLong(),
            )
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to update playback state: ${e.message}")
        }
    }

    @Command
    fun set_media_session_active(invoke: Invoke) {
        var args = invoke.parseArgs(SetMediaSessionActiveArgs::class.java)
        val active = args.active ?: true

        args.notificationTitle?.let { NOTIFICATION_TITLE = it }
        args.notificationText?.let { NOTIFICATION_TEXT = it }
        args.foregroundServiceTitle?.let { FOREGROUND_SERVICE_TITLE = it }
        args.foregroundServiceText?.let { FOREGROUND_SERVICE_TEXT = it }

        try {
            if (active) {
                cancelIdleTimer()
                MediaPlaybackService.pluginEventTrigger = { event, data -> trigger(event, data) }
                MediaPlaybackService.currentTitle = FOREGROUND_SERVICE_TITLE
                MediaPlaybackService.currentArtist = FOREGROUND_SERVICE_TEXT
                // Persist the book so the Android Auto browse tree can offer a
                // "Resume last book" entry after the process is cold.
                args.bookHash?.let {
                    MediaPlaybackService.saveLastBook(activity, it, args.bookTitle, args.bookAuthor)
                }
                val intent = Intent(activity, MediaPlaybackService::class.java).apply {
                    action = MediaPlaybackService.ACTION_ACTIVATE_SESSION
                }
                Log.d(TAG, "set_media_session_active: startForegroundService")
                ContextCompat.startForegroundService(activity, intent)
            } else {
                // Not stopService: Android Auto may keep the service bound for
                // browsing, in which case stopService would leave the foreground
                // notification and the keep-alive player running.
                MediaPlaybackService.requestDeactivation()
                MediaPlaybackService.pluginEventTrigger = null
            }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to set media session active state: ${e.message}")
        }
    }
    
    private fun startIdleTimer() {
        idleHandler.removeCallbacks(idleShutdownRunnable)
        idleHandler.postDelayed(idleShutdownRunnable, IDLE_TIMEOUT_MS)
    }

    private fun cancelIdleTimer() {
        idleHandler.removeCallbacks(idleShutdownRunnable)
    }

    private fun shutdownTTSEngine() {
        try {
            MediaPlaybackService.requestDeactivation()
            MediaPlaybackService.pluginEventTrigger = null

            synthesisBroker.shutdown()
            operationGate.forceRelease()
            textToSpeech?.shutdown()
            textToSpeech = null
            initializedEnginePackage = null
            isInitialized.set(false)
            isSpeaking.set(false)
            isPaused.set(false)

            speakingJobs.values.forEach { it.cancel() }
            eventChannels.values.forEach { it.close() }
            speakingJobs.clear()
            eventChannels.clear()

            Log.d(TAG, "TTS engine shut down due to idle timeout")
        } catch (e: Exception) {
            Log.e(TAG, "Error during idle TTS shutdown", e)
        }
    }

    fun destroy() {
        try {
            cancelIdleTimer()

            MediaPlaybackService.requestDeactivation()
            MediaPlaybackService.pluginEventTrigger = null

            synthesisBroker.shutdown()
            operationGate.forceRelease()
            coroutineScope.cancel()
            textToSpeech?.shutdown()
            textToSpeech = null
            initializedEnginePackage = null
            isInitialized.set(false)
            eventChannels.values.forEach { it.close() }
            eventChannels.clear()
            speakingJobs.values.forEach { it.cancel() }
            speakingJobs.clear()

            Log.d(TAG, "Plugin destroyed successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Error during plugin destruction", e)
        }
    }
}
