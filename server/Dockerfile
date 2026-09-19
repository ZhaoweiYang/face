# GPU image: LivePortrait + the Face3D clip service + the built front-end.
# Build from the repository root:  docker build -t face3d-server -f server/Dockerfile .

FROM node:22-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 https://github.com/KwaiVGI/LivePortrait.git \
    && cd LivePortrait \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir "huggingface_hub[cli]" \
    && huggingface-cli download KwaiVGI/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"

WORKDIR /app/server
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ .
COPY --from=frontend /app/dist /app/dist

ENV FACE3D_ENGINE=liveportrait LIVEPORTRAIT_DIR=/opt/LivePortrait FACE3D_DATA_DIR=/app/server/data FACE3D_FRONTEND_DIR=/app/dist
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
