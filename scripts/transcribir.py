# Transcribe el audio de un video con faster-whisper (local, sin API). Lo usa src/instagram/videos.ts.
# Uso: python transcribir.py <video>  → imprime el texto en stdout.
# El audio se decodifica con ffmpeg y se pasa como arreglo: el decodificador propio de
# faster-whisper (PyAV) choca con la versión que trae el runner de GitHub.
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

crudo = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", sys.argv[1], "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
    capture_output=True,
    check=True,
).stdout
audio = np.frombuffer(crudo, dtype=np.float32)
# "base" alcanza para saber de qué va un video y es ~3 veces más rápido que "small" en CPU.
modelo = WhisperModel("base", device="cpu", compute_type="int8")
segmentos, _ = modelo.transcribe(audio, language="es", vad_filter=True)
print(" ".join(s.text.strip() for s in segmentos))
