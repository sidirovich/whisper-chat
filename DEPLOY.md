# Деплой на Google Cloud Run

Контейнерный деплой без изменения кода: Cloud Run поддерживает долгоживущие
WebSocket-соединения, а `--source .` собирает наш `Dockerfile` в облаке через
Cloud Build — локальный Docker не нужен.

## Почему именно такие флаги

- `--min-instances=1` — комнаты живут в RAM процесса; scale-to-zero убивал бы их
  между сообщениями. Один всегда живой инстанс = стабильные комнаты.
- `--max-instances=1` — состояние комнат не разделяется между инстансами (нет Redis
  adapter по задумке «только RAM»), поэтому масштабироваться по горизонтали нельзя.
- `--session-affinity` — привязка запросов одного клиента к одному инстансу;
  нужна для polling-fallback Socket.IO (WebSocket работает и без неё).
- `--timeout=3600` — максимум Cloud Run: WS-соединение живёт до 60 минут, затем
  обрезается. Клиент **автоматически** переподключается и перезаходит в комнату
  теми же ключами (уже реализовано) — пользователи этого не замечают.
- `--allow-unauthenticated` — публичный чат по HTTPS-ссылке `*.run.app`
  (TLS из коробки — Web Crypto работает; на своём домене тоже).

## Шаги

```bash
# 1. CLI и проект: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud config set project ВАШ_PROJECT_ID

# 2. Включить нужные API (один раз)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 3. Деплой (первая сборка ~3–5 минут, дальше кэшируется)
gcloud run deploy encrypt-chat \
  --source . \
  --region europe-north1 \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 1 \
  --max-instances 1 \
  --session-affinity \
  --cpu 1 \
  --memory 512Mi \
  --timeout 3600
```

После деплоя CLI отдаст URL вида `https://encrypt-chat-xxxx-ew.a.run.app` —
это и есть адрес чата: открывайте, создавайте комнаты, делитесь ссылками-приглашениями.

Обновление — повторить команду `gcloud run deploy ...` (те же флаги; регион и
настройки сервиса запоминаются, достаточно `gcloud run deploy encrypt-chat --source .`).

Логи и состояние:

```bash
gcloud run services list
gcloud beta run services logs read encrypt-chat --region europe-north1 --limit 50
curl https://ВАШ_URL/healthz   # {"ok":true} — снаружи только живость
```

## Стоимость (ориентир)

`min-instances=1` (1 vCPU burst, 512 MiB) — это всегда активный маленький инстанс,
порядка нескольких долларов в месяц. Для коротких экспериментов можно
`--min-instances 0`: простаивающий сервис засыпает, но все комнаты при этом
исчезают (RAM-only), а «холодный» первый запрос ждёт загрузки контейнера.

## Альтернатива: готовый образ через Artifact Registry

Если нужен контроль над сборкой (CI/локальный Docker):

```bash
gcloud artifacts repositories create encrypt-chat --repository-format=docker --region europe-north1
docker build -t europe-north1-docker.pkg.dev/ВАШ_PROJECT_ID/encrypt-chat/app:latest .
docker push europe-north1-docker.pkg.dev/ВАШ_PROJECT_ID/encrypt-chat/app:latest
gcloud run deploy encrypt-chat --image europe-north1-docker.pkg.dev/ВАШ_PROJECT_ID/encrypt-chat/app:latest \
  --region europe-north1 --allow-unauthenticated --port 8080 \
  --min-instances 1 --max-instances 1 --session-affinity --timeout 3600
```

## Локальная проверка контейнера (если есть Docker)

```bash
docker build -t encrypt-chat .
docker run --rm -p 8090:8080 encrypt-chat
# в другом терминале:
curl http://127.0.0.1:8090/healthz
node test/e2e-protocol.mjs   # с PORT=8090: PORT=8090 node test/e2e-protocol.mjs
```
