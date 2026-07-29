use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_tts);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativeTts<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.readest.native_tts", "NativeTTSPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_native_tts)?;
    Ok(NativeTts(handle))
}

/// Access to the native-tts APIs.
pub struct NativeTts<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativeTts<R> {
    pub fn init(&self) -> crate::Result<InitResponse> {
        self.0.run_mobile_plugin("init", ()).map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn speak(&self, payload: SpeakArgs) -> crate::Result<SpeakResponse> {
        self.0
            .run_mobile_plugin("speak", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn pause(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("pause", ()).map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn resume(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("resume", ()).map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn stop(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("stop", ()).map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn set_rate(&self, payload: SetRateArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_rate", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn set_pitch(&self, payload: SetPitchArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_pitch", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn set_voice(&self, payload: SetVoiceArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_voice", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn get_all_voices(&self) -> crate::Result<GetVoicesResponse> {
        self.0
            .run_mobile_plugin("get_all_voices", ())
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub async fn synthesize_to_file(
        &self,
        payload: SynthesizeToFileArgs,
    ) -> crate::Result<SynthesizeToFileResponse> {
        payload.validate()?;
        let cleanup = CancelSynthesisArgs {
            session_id: payload.session_id.clone(),
            request_id: payload.request_id.clone(),
            generation: payload.generation,
        };
        let native = self
            .0
            .run_mobile_plugin_async::<NativeSynthesizeToFileResponse>(
                "synthesize_to_file",
                payload.clone(),
            )
            .await
            .map_err(crate::Error::from)?;
        match native.validate_for(&payload) {
            Ok(response) => Ok(response),
            Err(error) => {
                // Validation happens after Android created a private ready asset,
                // so discard it before surfacing the typed failure. A rejected
                // native invoke has already settled and cleaned its request; it
                // returns above without a second cancellation, which would poison
                // a coordinator retry that intentionally reuses the request ID.
                let _ = self
                    .0
                    .run_mobile_plugin_async::<()>("cancel_synthesis", cleanup)
                    .await;
                Err(error)
            }
        }
    }

    pub async fn read_synthesis_audio(
        &self,
        payload: ReadSynthesisAudioArgs,
    ) -> crate::Result<Vec<u8>> {
        payload.validate()?;
        let response: NativeReadSynthesisAudioResponse = self
            .0
            .run_mobile_plugin_async("read_synthesis_audio", payload)
            .await?;
        decode_synthesis_audio(&response.data)
    }

    pub async fn cancel_synthesis(&self, payload: CancelSynthesisArgs) -> crate::Result<()> {
        payload.validate()?;
        self.0
            .run_mobile_plugin_async("cancel_synthesis", payload)
            .await
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn set_media_session_active(
        &self,
        payload: SetMediaSessionActiveRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("set_media_session_active", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn update_media_session_state(
        &self,
        payload: UpdateMediaSessionStateRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("update_media_session_state", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn update_media_session_metadata(
        &self,
        payload: UpdateMediaSessionMetadataRequest,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("update_media_session_metadata", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn update_carplay_state(&self, payload: UpdateCarPlayStateRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("update_carplay_state", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn playout_enqueue(
        &self,
        payload: PlayoutEnqueueRequest,
    ) -> crate::Result<PlayoutEnqueueResponse> {
        self.0
            .run_mobile_plugin("playout_enqueue", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn playout_control(
        &self,
        payload: PlayoutControlRequest,
    ) -> crate::Result<PlayoutControlResponse> {
        self.0
            .run_mobile_plugin("playout_control", payload)
            .map_err(Into::into)
    }
}

impl<R: Runtime> NativeTts<R> {
    pub fn playout_position(&self) -> crate::Result<PlayoutPositionResponse> {
        self.0
            .run_mobile_plugin("playout_position", ())
            .map_err(Into::into)
    }
}
