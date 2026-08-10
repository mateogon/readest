use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSMessageEvent {
    pub code: String, // 'boundary' | 'error' | 'end'
    pub message: Option<String>,
    pub mark: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitResponse {
    pub success: bool,
    #[serde(default)]
    pub engine_package: Option<String>,
    #[serde(default)]
    pub engine_version: Option<String>,
    #[serde(default)]
    pub max_input_length: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakArgs {
    pub text: String,
    #[serde(default)]
    pub preload: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResponse {
    pub utterance_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRateArgs {
    pub rate: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPitchArgs {
    pub pitch: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetVoiceArgs {
    pub voice: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetVoicesResponse {
    pub voices: Vec<TTSVoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeToFileArgs {
    pub text: String,
    pub engine_package: String,
    pub voice: String,
    pub locale: String,
    pub pitch: f32,
    pub rate: f32,
    pub session_id: String,
    pub request_id: String,
    pub generation: u64,
}

impl SynthesizeToFileArgs {
    #[cfg(any(mobile, test))]
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.text.trim().is_empty() {
            return Err(crate::Error::InvalidSynthesisRequest(
                "text must not be empty or whitespace-only".to_owned(),
            ));
        }
        for (name, value) in [
            ("enginePackage", self.engine_package.as_str()),
            ("voice", self.voice.as_str()),
            ("locale", self.locale.as_str()),
            ("sessionId", self.session_id.as_str()),
            ("requestId", self.request_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(crate::Error::InvalidSynthesisRequest(format!(
                    "{name} must not be empty"
                )));
            }
        }
        if !self.pitch.is_finite() || self.pitch <= 0.0 {
            return Err(crate::Error::InvalidSynthesisRequest(
                "pitch must be finite and greater than zero".to_owned(),
            ));
        }
        if !self.rate.is_finite() || self.rate != 1.0 {
            return Err(crate::Error::InvalidSynthesisRequest(
                "synthesis rate must be exactly 1.0".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(any(mobile, test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSynthesisRange {
    pub start: i64,
    pub end: i64,
    pub frame: i64,
}

#[cfg(any(mobile, test))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSynthesizeToFileResponse {
    pub asset_id: String,
    pub sample_rate: i64,
    pub frame_count: i64,
    pub duration_sec: f64,
    pub engine_package: String,
    pub engine_version: String,
    pub max_input_length: i64,
    #[serde(default)]
    pub ranges: Vec<NativeSynthesisRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisBoundary {
    pub offset: u64,
    pub duration: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_end: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeToFileResponse {
    pub asset_id: String,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub duration_sec: f64,
    pub engine_package: String,
    pub engine_version: String,
    pub max_input_length: u32,
    pub boundaries: Vec<SynthesisBoundary>,
}

#[cfg(any(mobile, test))]
impl NativeSynthesizeToFileResponse {
    pub(crate) fn validate_for(
        self,
        request: &SynthesizeToFileArgs,
    ) -> crate::Result<SynthesizeToFileResponse> {
        request.validate()?;

        if self.asset_id.trim().is_empty() {
            return Err(crate::Error::InvalidSynthesisMetadata(
                "assetId must not be empty".to_owned(),
            ));
        }
        if self.engine_package.trim().is_empty() {
            return Err(crate::Error::InvalidSynthesisMetadata(
                "enginePackage must not be empty".to_owned(),
            ));
        }
        if self.engine_package != request.engine_package {
            return Err(crate::Error::InvalidSynthesisMetadata(
                "enginePackage does not match the atomic request".to_owned(),
            ));
        }

        let sample_rate = u32::try_from(self.sample_rate)
            .ok()
            .filter(|rate| *rate > 0)
            .ok_or_else(|| {
                crate::Error::InvalidSynthesisMetadata(
                    "sampleRate must be a positive 32-bit integer".to_owned(),
                )
            })?;
        let frame_count = u64::try_from(self.frame_count)
            .ok()
            .filter(|frames| *frames > 0)
            .ok_or_else(|| {
                crate::Error::InvalidSynthesisMetadata(
                    "frameCount must be a positive integer".to_owned(),
                )
            })?;
        let max_input_length = u32::try_from(self.max_input_length)
            .ok()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| {
                crate::Error::InvalidSynthesisMetadata(
                    "maxInputLength must be a positive 32-bit integer".to_owned(),
                )
            })?;

        let text_len_utf16 = request.text.encode_utf16().count();
        if text_len_utf16 > max_input_length as usize {
            return Err(crate::Error::InvalidSynthesisRequest(
                "text exceeds the Android TTS input limit".to_owned(),
            ));
        }

        let duration_sec = frame_count as f64 / sample_rate as f64;
        let duration_tolerance = (1.0 / sample_rate as f64).max(0.001);
        if !self.duration_sec.is_finite()
            || self.duration_sec <= 0.0
            || (self.duration_sec - duration_sec).abs() > duration_tolerance
        {
            return Err(crate::Error::InvalidSynthesisMetadata(
                "durationSec does not match frameCount/sampleRate".to_owned(),
            ));
        }

        let boundaries = normalize_ranges(&request.text, &self.ranges, sample_rate, frame_count)
            .unwrap_or_default();

        Ok(SynthesizeToFileResponse {
            asset_id: self.asset_id,
            sample_rate,
            frame_count,
            duration_sec,
            engine_package: self.engine_package,
            engine_version: self.engine_version,
            max_input_length,
            boundaries,
        })
    }
}

#[cfg(any(mobile, test))]
const TICKS_PER_SECOND: u128 = 10_000_000;

#[cfg(any(mobile, test))]
fn normalize_ranges(
    text: &str,
    ranges: &[NativeSynthesisRange],
    sample_rate: u32,
    frame_count: u64,
) -> Option<Vec<SynthesisBoundary>> {
    if ranges.is_empty() {
        return Some(Vec::new());
    }

    let utf16: Vec<u16> = text.encode_utf16().collect();
    let mut previous_end = 0_usize;
    let mut previous_frame = None;
    let mut validated = Vec::with_capacity(ranges.len());

    for range in ranges {
        let start = usize::try_from(range.start).ok()?;
        let end = usize::try_from(range.end).ok()?;
        let frame = u64::try_from(range.frame).ok()?;
        if start >= end
            || end > utf16.len()
            || start < previous_end
            || frame >= frame_count
            || !is_utf16_boundary(&utf16, start)
            || !is_utf16_boundary(&utf16, end)
            || previous_frame.is_some_and(|previous| frame <= previous)
        {
            return None;
        }

        let range_text = String::from_utf16(&utf16[start..end]).ok()?;
        let text_start = u32::try_from(start).ok()?;
        let text_end = u32::try_from(end).ok()?;
        validated.push((frame, text_start, text_end, range_text));
        previous_end = end;
        previous_frame = Some(frame);
    }

    let mut boundaries = Vec::with_capacity(validated.len());
    for (index, (frame, text_start, text_end, range_text)) in validated.iter().enumerate() {
        let end_frame = validated
            .get(index + 1)
            .map(|(next_frame, _, _, _)| *next_frame)
            .unwrap_or(frame_count);
        let offset = frame_to_ticks(*frame, sample_rate)?;
        let end = frame_to_ticks(end_frame, sample_rate)?;
        let duration = end.checked_sub(offset)?;
        if duration == 0 {
            return None;
        }
        boundaries.push(SynthesisBoundary {
            offset,
            duration,
            text: range_text.clone(),
            text_start: Some(*text_start),
            text_end: Some(*text_end),
        });
    }
    Some(boundaries)
}

#[cfg(any(mobile, test))]
fn is_utf16_boundary(text: &[u16], offset: usize) -> bool {
    if offset == 0 || offset == text.len() {
        return true;
    }
    !(is_high_surrogate(text[offset - 1]) && is_low_surrogate(text[offset]))
}

#[cfg(any(mobile, test))]
fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

#[cfg(any(mobile, test))]
fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

#[cfg(any(mobile, test))]
fn frame_to_ticks(frame: u64, sample_rate: u32) -> Option<u64> {
    let ticks = u128::from(frame)
        .checked_mul(TICKS_PER_SECOND)?
        .checked_div(u128::from(sample_rate))?;
    u64::try_from(ticks).ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSynthesisAudioArgs {
    pub asset_id: String,
}

impl ReadSynthesisAudioArgs {
    #[cfg(mobile)]
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.asset_id.trim().is_empty() {
            return Err(crate::Error::InvalidSynthesisRequest(
                "assetId must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(mobile)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeReadSynthesisAudioResponse {
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSynthesisArgs {
    pub session_id: String,
    pub request_id: String,
    pub generation: u64,
}

impl CancelSynthesisArgs {
    #[cfg(mobile)]
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.session_id.trim().is_empty() || self.request_id.trim().is_empty() {
            return Err(crate::Error::InvalidSynthesisRequest(
                "sessionId and requestId must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(any(mobile, test))]
pub(crate) fn decode_synthesis_audio(encoded: &str) -> crate::Result<Vec<u8>> {
    use base64::Engine as _;

    let wav = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| {
            crate::Error::InvalidSynthesisAudio(format!("invalid base64 payload: {error}"))
        })?;
    validate_pcm16_mono_wav(&wav)?;
    Ok(wav)
}

#[cfg(any(mobile, test))]
fn validate_pcm16_mono_wav(wav: &[u8]) -> crate::Result<()> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(crate::Error::InvalidSynthesisAudio(
            "audio is not a RIFF/WAVE file".to_owned(),
        ));
    }

    let riff_size = read_u32_le(wav, 4)? as usize;
    if riff_size.checked_add(8) != Some(wav.len()) {
        return Err(crate::Error::InvalidSynthesisAudio(
            "RIFF length does not match the audio payload".to_owned(),
        ));
    }

    let mut cursor = 12_usize;
    let mut found_format = false;
    let mut block_align = None;
    let mut found_data = false;
    while cursor < wav.len() {
        let header_end = cursor.checked_add(8).ok_or_else(|| {
            crate::Error::InvalidSynthesisAudio("WAV chunk offset overflow".to_owned())
        })?;
        if header_end > wav.len() {
            return Err(crate::Error::InvalidSynthesisAudio(
                "truncated WAV chunk header".to_owned(),
            ));
        }
        let chunk_id = &wav[cursor..cursor + 4];
        let chunk_len = read_u32_le(wav, cursor + 4)? as usize;
        let data_start = cursor + 8;
        let data_end = data_start.checked_add(chunk_len).ok_or_else(|| {
            crate::Error::InvalidSynthesisAudio("WAV chunk length overflow".to_owned())
        })?;
        if data_end > wav.len() {
            return Err(crate::Error::InvalidSynthesisAudio(
                "truncated WAV chunk".to_owned(),
            ));
        }

        match chunk_id {
            b"fmt " => {
                if chunk_len < 16 {
                    return Err(crate::Error::InvalidSynthesisAudio(
                        "WAV fmt chunk is too short".to_owned(),
                    ));
                }
                let audio_format = read_u16_le(wav, data_start)?;
                let channels = read_u16_le(wav, data_start + 2)?;
                let sample_rate = read_u32_le(wav, data_start + 4)?;
                let byte_rate = read_u32_le(wav, data_start + 8)?;
                let alignment = read_u16_le(wav, data_start + 12)?;
                let bits_per_sample = read_u16_le(wav, data_start + 14)?;
                if audio_format != 1
                    || channels != 1
                    || sample_rate == 0
                    || bits_per_sample != 16
                    || alignment != 2
                    || byte_rate != sample_rate.saturating_mul(2)
                {
                    return Err(crate::Error::InvalidSynthesisAudio(
                        "WAV must be mono PCM16 with consistent rate metadata".to_owned(),
                    ));
                }
                block_align = Some(alignment as usize);
                found_format = true;
            }
            b"data" => {
                let alignment = block_align.ok_or_else(|| {
                    crate::Error::InvalidSynthesisAudio(
                        "WAV data chunk precedes its fmt chunk".to_owned(),
                    )
                })?;
                if chunk_len == 0 || chunk_len % alignment != 0 {
                    return Err(crate::Error::InvalidSynthesisAudio(
                        "WAV data length is not a positive whole frame count".to_owned(),
                    ));
                }
                found_data = true;
            }
            _ => {}
        }

        let padded_len = chunk_len.checked_add(chunk_len % 2).ok_or_else(|| {
            crate::Error::InvalidSynthesisAudio("WAV padding overflow".to_owned())
        })?;
        cursor = data_start.checked_add(padded_len).ok_or_else(|| {
            crate::Error::InvalidSynthesisAudio("WAV chunk cursor overflow".to_owned())
        })?;
        if cursor > wav.len() {
            return Err(crate::Error::InvalidSynthesisAudio(
                "truncated WAV padding".to_owned(),
            ));
        }
    }

    if !found_format || !found_data {
        return Err(crate::Error::InvalidSynthesisAudio(
            "WAV is missing fmt or data metadata".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(any(mobile, test))]
fn read_u16_le(bytes: &[u8], offset: usize) -> crate::Result<u16> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| crate::Error::InvalidSynthesisAudio("truncated WAV integer".to_owned()))?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

#[cfg(any(mobile, test))]
fn read_u32_le(bytes: &[u8], offset: usize) -> crate::Result<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| crate::Error::InvalidSynthesisAudio("truncated WAV integer".to_owned()))?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMediaSessionActiveRequest {
    pub active: bool,
    pub notification_title: Option<String>,
    pub notification_text: Option<String>,
    pub foreground_service_title: Option<String>,
    pub foreground_service_text: Option<String>,
    // Identity of the book being read, persisted so the Android Auto browse
    // tree can offer a "Resume last book" entry after the process is cold.
    pub book_hash: Option<String>,
    pub book_title: Option<String>,
    pub book_author: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaSessionStateRequest {
    pub playing: bool,
    pub position: Option<f64>,
    pub duration: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMediaSessionMetadataRequest {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCarPlayStateRequest {
    pub active: bool,
    pub title: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutEnqueueRequest {
    pub session: i32,
    pub index: i32,
    pub data: String,
    pub gap_ms: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutEnqueueResponse {
    pub duration_ms: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutControlRequest {
    pub action: String,
    pub rate: Option<f64>,
    // Absolute file path for action "load" (Media Overlay continuous playout).
    pub path: Option<String>,
    // Seek target for actions "load" and "seek", in milliseconds.
    pub position_ms: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutControlResponse {
    pub session: Option<i32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayoutPositionResponse {
    pub session: i32,
    pub index: i32,
    pub position_ms: f64,
    pub playing: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_result(text: &str) -> (SynthesizeToFileArgs, NativeSynthesizeToFileResponse) {
        let utf16_len = text.encode_utf16().count() as i64;
        (
            SynthesizeToFileArgs {
                text: text.to_owned(),
                engine_package: "example.tts".to_owned(),
                voice: "engine.voice".to_owned(),
                locale: "es-CL".to_owned(),
                pitch: 1.0,
                rate: 1.0,
                session_id: "session-1".to_owned(),
                request_id: "request-1".to_owned(),
                generation: 3,
            },
            NativeSynthesizeToFileResponse {
                asset_id: "asset-1".to_owned(),
                sample_rate: 100,
                frame_count: 300,
                duration_sec: 3.0,
                engine_package: "example.tts".to_owned(),
                engine_version: "1.2.3".to_owned(),
                max_input_length: 4_000,
                ranges: vec![NativeSynthesisRange {
                    start: 0,
                    end: utf16_len,
                    frame: 0,
                }],
            },
        )
    }

    #[test]
    fn converts_utf16_ranges_and_frames_to_edge_ticks() {
        let text = "Hola 😀 cafe\u{301}";
        let (args, mut native) = native_result(text);
        native.ranges = vec![
            NativeSynthesisRange {
                start: 0,
                end: 4,
                frame: 0,
            },
            NativeSynthesisRange {
                start: 5,
                end: 7,
                frame: 100,
            },
            NativeSynthesisRange {
                start: 8,
                end: 13,
                frame: 200,
            },
        ];

        let result = native
            .validate_for(&args)
            .expect("valid synthesis metadata");

        assert_eq!(result.duration_sec, 3.0);
        assert_eq!(
            result.boundaries,
            vec![
                SynthesisBoundary {
                    offset: 0,
                    duration: 10_000_000,
                    text: "Hola".to_owned(),
                    text_start: Some(0),
                    text_end: Some(4),
                },
                SynthesisBoundary {
                    offset: 10_000_000,
                    duration: 10_000_000,
                    text: "😀".to_owned(),
                    text_start: Some(5),
                    text_end: Some(7),
                },
                SynthesisBoundary {
                    offset: 20_000_000,
                    duration: 10_000_000,
                    text: "cafe\u{301}".to_owned(),
                    text_start: Some(8),
                    text_end: Some(13),
                },
            ]
        );
    }

    #[test]
    fn serializes_android_utf16_offsets_in_the_public_boundary_contract() {
        let text = "A😀e\u{301}";
        let (args, mut native) = native_result(text);
        native.ranges = vec![
            NativeSynthesisRange {
                start: 0,
                end: 1,
                frame: 0,
            },
            NativeSynthesisRange {
                start: 1,
                end: 3,
                frame: 100,
            },
            NativeSynthesisRange {
                start: 3,
                end: 5,
                frame: 200,
            },
        ];

        let result = native
            .validate_for(&args)
            .expect("valid synthesis metadata");
        let serialized = serde_json::to_value(result).expect("serialize public response");

        assert_eq!(
            serialized["boundaries"],
            serde_json::json!([
                {
                    "offset": 0,
                    "duration": 10_000_000,
                    "text": "A",
                    "textStart": 0,
                    "textEnd": 1
                },
                {
                    "offset": 10_000_000,
                    "duration": 10_000_000,
                    "text": "😀",
                    "textStart": 1,
                    "textEnd": 3
                },
                {
                    "offset": 20_000_000,
                    "duration": 10_000_000,
                    "text": "e\u{301}",
                    "textStart": 3,
                    "textEnd": 5
                }
            ])
        );
    }

    #[test]
    fn invalid_range_list_falls_back_to_no_boundaries() {
        let text = "A😀B";
        let (args, mut native) = native_result(text);

        native.ranges = vec![NativeSynthesisRange {
            start: 1,
            end: 2,
            frame: 0,
        }];
        assert!(native
            .clone()
            .validate_for(&args)
            .expect("audio remains usable")
            .boundaries
            .is_empty());

        native.ranges = vec![
            NativeSynthesisRange {
                start: 0,
                end: 1,
                frame: 100,
            },
            NativeSynthesisRange {
                start: 3,
                end: 4,
                frame: 99,
            },
        ];
        assert!(native
            .validate_for(&args)
            .expect("audio remains usable")
            .boundaries
            .is_empty());

        let (args, mut native) = native_result(text);
        native.ranges = vec![NativeSynthesisRange {
            start: 0,
            end: 5,
            frame: 0,
        }];
        assert!(native
            .validate_for(&args)
            .expect("audio remains usable")
            .boundaries
            .is_empty());
    }

    #[test]
    fn rejects_inconsistent_audio_metadata_and_oversized_text() {
        let (args, mut native) = native_result("hola");
        native.duration_sec = 4.0;
        assert!(matches!(
            native.clone().validate_for(&args),
            Err(crate::Error::InvalidSynthesisMetadata(_))
        ));

        native.duration_sec = 3.0;
        native.max_input_length = 3;
        assert!(matches!(
            native.validate_for(&args),
            Err(crate::Error::InvalidSynthesisRequest(_))
        ));
    }

    #[test]
    fn enforces_atomic_engine_and_rate_one_contract() {
        let (mut args, native) = native_result("hola");
        args.rate = 1.5;
        assert!(matches!(
            native.clone().validate_for(&args),
            Err(crate::Error::InvalidSynthesisRequest(_))
        ));

        args.rate = 1.0;
        args.engine_package = "different.engine".to_owned();
        assert!(matches!(
            native.validate_for(&args),
            Err(crate::Error::InvalidSynthesisMetadata(_))
        ));

        let (args, mut native) = native_result("hola");
        native.engine_version.clear();
        assert_eq!(
            native
                .validate_for(&args)
                .expect("version is best-effort")
                .engine_version,
            ""
        );

        let (mut args, native) = native_result("hola");
        args.text = "   ".to_owned();
        assert!(matches!(
            native.validate_for(&args),
            Err(crate::Error::InvalidSynthesisRequest(_))
        ));
    }

    #[test]
    fn init_response_remains_compatible_with_success_only_mobile_plugins() {
        let response: InitResponse =
            serde_json::from_str(r#"{"success":true}"#).expect("deserialize legacy init");
        assert!(response.success);
        assert!(response.engine_package.is_none());
        assert!(response.engine_version.is_none());
        assert!(response.max_input_length.is_none());
    }

    fn pcm16_mono_wav(sample_rate: u32, frames: u32) -> Vec<u8> {
        let data_len = frames * 2;
        let mut wav = Vec::with_capacity((44 + data_len) as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.resize((44 + data_len) as usize, 0);
        wav
    }

    #[test]
    fn decodes_and_validates_pcm16_mono_wav() {
        use base64::Engine as _;

        let wav = pcm16_mono_wav(44_100, 100);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&wav);
        assert_eq!(decode_synthesis_audio(&encoded).unwrap(), wav);
    }

    #[test]
    fn rejects_invalid_base64_and_invalid_wav() {
        use base64::Engine as _;

        assert!(matches!(
            decode_synthesis_audio("not base64"),
            Err(crate::Error::InvalidSynthesisAudio(_))
        ));
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"not a wav");
        assert!(matches!(
            decode_synthesis_audio(&encoded),
            Err(crate::Error::InvalidSynthesisAudio(_))
        ));
    }
}
