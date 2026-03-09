/* eslint-disable */
import type { AnyApi } from "convex/server";

export const api: {
  public: {
    registerDestination: any;
    removeDestination: any;
    updateDestination: any;
    queueWebhook: any;
    getDestination: any;
    listDestinations: any;
    getSigningSecret: any;
    getPublicKey: any;
    getWebhookStatus: any;
    getDeliveryHistory: any;
    getFailedWebhooks: any;
  };
} = null as any;

export const internal: {
  delivery: {
    deliver: any;
    getDeliveryData: any;
    recordResult: any;
    generateKeyPair: any;
    storeKeyPair: any;
    validateUrl: any;
    markUrlValidated: any;
    checkRateLimit: any;
  };
} = null as any;
