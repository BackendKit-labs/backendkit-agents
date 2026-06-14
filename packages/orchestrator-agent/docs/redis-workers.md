# Redis + BullMQ Distributed Execution

By default, the orchestrator executes subtasks inline within the MCP server process (single node, disk-based state). When `ORCHESTRATOR_REDIS_URL` is set, it switches to distributed mode: state moves to Redis and subtasks are dispatched via BullMQ queues to separate worker processes.

## Architecture

### Default mode (no Redis)

```
Claude Desktop / n8n HTTP
        ↓
  orchestrator-agent (MCP server)
    ├── RunStore → .orchestrator/runs/*.json
    ├── Step 1 → [LLM call inline]
    ├── Step 2 → [LLM call inline]
    └── Step 3 → [LLM call inline]
```

### Redis mode

```
Claude Desktop / n8n HTTP
        ↓
  orchestrator-agent (MCP server)
    ├── RunStore → Redis sorted set
    ├── Step 1 → subtasks.hr-agent queue ──→ [worker process A]
    ├── Step 2 → subtasks.it-agent queue ──→ [worker process B]
    └── Step 3 → subtasks.hr-agent queue ──→ [worker process A or C]

  Redis
    ├── orchestrator:{hash}:runs       (sorted set: runId by startedAt)
    ├── orchestrator:{hash}:run:{id}   (JSON blob for each run)
    └── bull:subtasks.{agentId}:*      (BullMQ internal keys)
```

Multiple orchestrator instances and multiple worker processes all share the same Redis state.

## When to use Redis mode

| Scenario | Recommendation |
|----------|---------------|
| Single server, low volume | Default (disk) — simpler, no extra deps |
| Multiple orchestrator instances | Redis — shared state across instances |
| Long-running tasks that must survive restarts | Redis — jobs persist in queue |
| High-volume (many concurrent runs) | Redis — workers scale independently |
| Docker / Kubernetes deployment | Redis — state lives outside the container |

## Setup

### 1. Start Redis

```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
```

### 2. Start the orchestrator with Redis

```bash
ORCHESTRATOR_CONFIG=./orchestrator.yaml \
ORCHESTRATOR_HTTP_PORT=3000 \
ORCHESTRATOR_REDIS_URL=redis://localhost:6379 \
orchestrator-agent
```

On startup you'll see:
```
[orchestrator-agent] RunStore → Redis (redis://localhost:6379)
[orchestrator-agent] HTTP trigger on :3000 — config: ./orchestrator.yaml
[orchestrator-agent] MCP running
```

### 3. Start one or more workers

The worker process registers one BullMQ consumer per agent and processes subtask jobs.

```bash
ORCHESTRATOR_CONFIG=./orchestrator.yaml \
ORCHESTRATOR_REDIS_URL=redis://localhost:6379 \
orchestrator-worker
```

Output:
```
[orchestrator-worker] Ready — 6 worker(s): hr-agent, it-agent, legal-agent, writer-agent, analyst-agent, risk-agent
[orchestrator-worker] Config: /path/to/orchestrator.yaml
[orchestrator-worker] Redis:  redis://localhost:6379
```

Each worker handles all agents defined in `orchestrator.yaml`. You can run multiple worker processes for load distribution — BullMQ ensures each job is processed by exactly one worker.

## Environment variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_REDIS_URL` | Redis connection URL (e.g. `redis://localhost:6379`, `redis://:password@host:6379`) |
| `ORCHESTRATOR_CONFIG` | Path to `orchestrator.yaml` (required for worker process) |

## Job retry behavior

BullMQ is configured with:
- **3 attempts** per job (retried on failure)
- **Exponential backoff**: 2s, 4s, 8s between retries
- **Auto-cleanup**: completed jobs removed after 100 entries; failed after 50

## Docker Compose example

```yaml
services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --save 60 1 --loglevel warning

  orchestrator:
    image: node:20-alpine
    command: npx -y @backendkit-labs/orchestrator-agent
    environment:
      ORCHESTRATOR_CONFIG: /app/orchestrator.yaml
      ORCHESTRATOR_HTTP_PORT: 3000
      ORCHESTRATOR_API_KEY: ${ORCHESTRATOR_API_KEY}
      ORCHESTRATOR_REDIS_URL: redis://redis:6379
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
    volumes:
      - ./orchestrator.yaml:/app/orchestrator.yaml:ro
      - ./flows:/app/flows:ro
    ports:
      - "3000:3000"
    depends_on: [redis]

  worker:
    image: node:20-alpine
    command: npx -y @backendkit-labs/orchestrator-agent orchestrator-worker
    environment:
      ORCHESTRATOR_CONFIG: /app/orchestrator.yaml
      ORCHESTRATOR_REDIS_URL: redis://redis:6379
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
    volumes:
      - ./orchestrator.yaml:/app/orchestrator.yaml:ro
    depends_on: [redis]
    deploy:
      replicas: 2    # scale workers independently

volumes:
  redis-data:
```

## Redis key structure

The orchestrator uses a namespace prefix derived from the config file path (SHA-256 first 12 chars) to avoid key collisions when multiple orchestrator configs share the same Redis instance.

```
orchestrator:{prefix}:runs          ← sorted set, score = startedAt epoch ms
orchestrator:{prefix}:run:{runId}   ← JSON string (RunState)
bull:subtasks.{agentId}:*          ← BullMQ internal keys
```

## Graceful shutdown

The worker process handles `SIGTERM` and `SIGINT`:

```bash
kill -TERM <worker-pid>
# [orchestrator-worker] Shutting down…
# (waits for in-progress jobs to complete)
# exits cleanly
```

In Kubernetes, set `terminationGracePeriodSeconds` to at least 60 to allow long-running LLM calls to finish.

## Monitoring

BullMQ exposes metrics via the [Bull Board](https://github.com/felixmosh/bull-board) dashboard. Add it to your stack to visualize queue depths, failed jobs, and throughput:

```bash
npm install @bull-board/express @bull-board/api
```

Connect it to the same Redis instance and the `subtasks.{agentId}` queues.
