FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VCT_DB_PATH=/data/vct.sqlite3 \
    VCT_RAW_ROOT=/data/raw/vlr/daily \
    PORT=8080

WORKDIR /app

COPY pyproject.toml requirements.txt ./
COPY src ./src
RUN pip install --no-cache-dir . -r requirements.txt

COPY bridge ./bridge
COPY artifacts ./artifacts
COPY seed ./seed
COPY runner_service.py ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8080')+'/healthz',timeout=3)"

CMD ["python", "runner_service.py"]
