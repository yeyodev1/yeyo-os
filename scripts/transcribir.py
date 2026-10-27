# Transcribe el audio de un video con faster-whisper (local, sin API). Lo usa src/instagram/videos.ts.
# Uso: python transcribir.py <audio.wav>  → imprime el texto en stdout.
import sys

from faster_whisper import WhisperModel

modelo = WhisperModel("small", device="cpu", compute_type="int8")
segmentos, _ = modelo.transcribe(sys.argv[1], language="es", vad_filter=True)
print(" ".join(s.text.strip() for s in segmentos))
