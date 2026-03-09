import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  destinations: defineTable({
    url: v.string(),
    secret: v.string(),
    deliveryMode: v.string(), // "serialized" | "parallel"
    maxRetries: v.number(),
    retryWindowMs: v.number(),
    rateLimitPerSecond: v.optional(v.number()),
    active: v.boolean(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    // Ed25519 key pair for asymmetric signing
    privateKey: v.optional(v.string()), // base64-encoded PKCS8
    publicKey: v.optional(v.string()), // base64-encoded SPKI
    urlValidated: v.optional(v.boolean()),
  }).index("by_url", ["url"]),

  webhooks: defineTable({
    destinationId: v.string(),
    eventType: v.string(),
    payload: v.any(),
    status: v.string(), // "pending" | "delivering" | "delivered" | "retrying" | "failed"
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    retryCount: v.number(),
    maxRetries: v.number(),
    retryWindowMs: v.number(),
  })
    .index("by_destination_status", ["destinationId", "status"])
    .index("by_destination_created", ["destinationId", "createdAt"])
    .index("by_status", ["status"]),

  deliveryAttempts: defineTable({
    webhookId: v.string(),
    destinationId: v.string(),
    timestamp: v.number(),
    statusCode: v.optional(v.number()),
    error: v.optional(v.string()),
    success: v.boolean(),
  })
    .index("by_webhook", ["webhookId", "timestamp"])
    .index("by_destination", ["destinationId", "timestamp"]),
});
