# Minimal always-on HTTP service, no GPU needed -- see app.py for the
# switcher logic. Lightweight enough that build time doesn't matter here.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
