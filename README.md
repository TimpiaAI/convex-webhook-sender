<div align="center">

# convex-webhook-sender

[![Convex Component](https://www.convex.dev/components/badge/convex-webhook-sender)](https://www.convex.dev/components/convex-webhook-sender)
![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=flat&logo=typescript&logoColor=white)

<strong>Managed webhook delivery for Convex</strong>

HMAC signing • Automatic retries • Exponential backoff • Delivery tracking

[View Demo](#-live-demo) • [Documentation](#-setup) • [API Reference](#-api-reference)

</div>

---

A Convex component for managed outbound webhook delivery with HMAC signing, retries, exponential backoff, and delivery tracking.

## Features

- **HMAC-SHA256 signing** with `whsec_` prefixed secrets (Standard Webhooks compatible)
- **Automatic retries** with exponential backoff (configurable max retries & window)
- **Delivery modes**: parallel (default) or serialized (FIFO per destination)
- **Delivery tracking**: full attempt history with status codes and errors
- **Signature verification utility** for webhook recipients

## Installation

```bash
npm install convex-webhook-sender
```

## Setup

In your `convex/convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import webhookSender from "convex-webhook-sender/convex.config";

const app = defineApp();
app.use(webhookSender);
export default app;
```

Create the client in a helper file like `convex/webhooks.ts`:

```typescript
import { WebhookSender } from "convex-webhook-sender";
import { components } from "./_generated/api";

export const webhooks = new WebhookSender(components.webhookSender);
```

## Usage

### Register a destination

```typescript
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { webhooks } from "./webhooks";

export const addWebhookEndpoint = mutation({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    const { destinationId, secret } = await webhooks.registerDestination(ctx, {
      url: args.url,
      maxRetries: 5,
      retryWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    });
    // Share `secret` with the recipient for signature verification
    return { destinationId, secret };
  },
});
```

### Send a webhook

```typescript
export const onOrderCreated = mutation({
  handler: async (ctx) => {
    await webhooks.send(ctx, {
      destinationId: "...",
      eventType: "order.created",
      payload: { orderId: "123", total: 99.99 },
    });
  },
});
```

### Query delivery status

```typescript
export const checkWebhook = query({
  args: { webhookId: v.string() },
  handler: async (ctx, args) => {
    return await webhooks.getWebhookStatus(ctx, args.webhookId);
  },
});
```

### Verify signatures (recipient side)

```typescript
import { verifyWebhookSignature } from "convex-webhook-sender";

// In your webhook handler (e.g., Express, Next.js API route)
const isValid = await verifyWebhookSignature(
  rawBody,
  {
    "webhook-id": req.headers["webhook-id"],
    "webhook-timestamp": req.headers["webhook-timestamp"],
    "webhook-signature": req.headers["webhook-signature"],
  },
  "whsec_your_secret_here"
);
```

## API

### `WebhookSender` class

| Method | Description |
|--------|-------------|
| `registerDestination(ctx, config)` | Register a new webhook URL. Returns `{ destinationId, secret }` |
| `removeDestination(ctx, id)` | Deactivate a destination |
| `updateDestination(ctx, id, updates)` | Update destination config |
| `send(ctx, { destinationId, eventType, payload })` | Queue a webhook for delivery |
| `getDestination(ctx, id)` | Get destination details |
| `listDestinations(ctx, options?)` | List all destinations |
| `getSigningSecret(ctx, id)` | Get the HMAC signing secret |
| `getWebhookStatus(ctx, id)` | Get webhook delivery status |
| `getDeliveryHistory(ctx, destId, options?)` | Get delivery attempt history |
| `getFailedWebhooks(ctx, destId, options?)` | Get failed webhooks |

### Webhook payload format

Webhooks are delivered as HTTP POST with:

```
POST <destination_url>
Content-Type: application/json
webhook-id: msg_<webhook_id>
webhook-timestamp: <unix_seconds>
webhook-signature: v1,<base64_hmac_sha256>

{"type":"<event_type>","timestamp":<unix_seconds>,"data":<payload>}
```

### Signature verification

The signature is computed as: `HMAC-SHA256(secret, "msg_id.timestamp.body")`

## 🚀 Live Demo

[![Live Demo](https://img.shields.io/badge/Live_Demo-Visit-blue?style=for-the-badge)](https://webhook-sender-demo.vercel.app)

[![Webhook Sender Demo](https://raw.githubusercontent.com/TimpiaAI/convex-webhook-sender/main/screenshot.png)](https://webhook-sender-demo.vercel.app)

[See the demo in action →](https://webhook-sender-demo.vercel.app)

## License

MIT

---

<div align="center">
Built with ❤️ for Convex | <a href="https://www.convex.dev/">Convex</a> • <a href="https://docs.convex.dev/components">Components</a> • <a href="https://github.com/get-convex">GitHub</a>
</div>
