FROM nvidia/cuda:12.6.0-cudnn-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y \
    python3.12 python3-pip python3.12-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --break-system-packages torch --index-url https://download.pytorch.org/whl/cu121
RUN pip install --break-system-packages -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
