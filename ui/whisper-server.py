"""Minimal faster-whisper HTTP server for Think Tank STT integration."""

import sys
import os
import json
import tempfile
import io
import email.parser
import email.policy
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("ERROR: faster-whisper is not installed.")
    print("Install it with:  pip install faster-whisper")
    sys.exit(1)

PORT = int(os.environ.get("WHISPER_PORT", 8300))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")

print(f"Loading Whisper model '{MODEL_SIZE}' on device '{DEVICE}'...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type="int8")
current_model_name = MODEL_SIZE
print(f"Whisper model loaded. Listening on port {PORT}")


def reload_model(new_model_size):
    """Reload whisper model with a different size."""
    global model, current_model_name
    print(f"Reloading model: {current_model_name} -> {new_model_size}")
    model = WhisperModel(new_model_size, device=DEVICE, compute_type="int8")
    current_model_name = new_model_size
    print(f"Model reloaded: {current_model_name}")


def parse_multipart(content_type, body):
    """Parse multipart/form-data using Python email module for robustness."""
    fields = {}
    files = {}

    # Build a full MIME message for the email parser
    raw_msg = b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(raw_msg)

    if msg.is_multipart():
        for part in msg.iter_parts():
            cd = part.get("Content-Disposition") or ""
            # Extract name from Content-Disposition
            name = part.get_param("name", header="Content-Disposition")
            filename = part.get_param("filename", header="Content-Disposition")
            payload = part.get_payload(decode=True)
            if not name:
                continue
            if filename:
                files[name] = (filename, payload)
            else:
                fields[name] = payload.decode("utf-8", errors="replace").strip()

    return fields, files


class WhisperHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/reload":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                new_model = data.get("model", "base")
                reload_model(new_model)
                self._json_response(200, {"ok": True, "model": new_model})
            except Exception as e:
                self._json_response(500, {"ok": False, "error": str(e)})
            return

        if self.path != "/transcribe":
            self._json_response(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        content_type = self.headers.get("Content-Type", "")
        body = self.rfile.read(content_length)

        fields, files = parse_multipart(content_type, body)
        language = fields.get("language", "auto").strip()

        print(f"[whisper] Transcribe request: language={language!r}, audio={'yes' if 'audio' in files else 'no'}")

        # auto = let whisper detect, otherwise force the specified language
        whisper_lang = None if language == "auto" else language

        if "audio" not in files:
            self._json_response(400, {"error": "no audio file"})
            return

        filename, audio_data = files["audio"]

        suffix = ".webm" if "webm" in filename else ".mp4"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name

        try:
            segments, info = model.transcribe(
                tmp_path,
                language=whisper_lang,
                beam_size=5,
                vad_filter=True
            )
            text = " ".join(seg.text.strip() for seg in segments)

            print(f"[whisper] Result: detected_lang={info.language}, text={text[:80]!r}")

            self._json_response(200, {
                "text": text,
                "language": info.language
            })
        except Exception as e:
            print(f"[whisper] Transcription error: {e}")
            self._json_response(500, {"error": str(e)})
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "model": current_model_name})
        else:
            self._json_response(404, {"error": "not found"})

    def _json_response(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[whisper] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), WhisperHandler)
    print(f"Whisper STT server running on http://0.0.0.0:{PORT}")
    server.serve_forever()
