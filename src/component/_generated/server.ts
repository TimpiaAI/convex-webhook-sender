/* eslint-disable */
import {
  actionGeneric,
  httpActionGeneric,
  queryGeneric,
  mutationGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  componentsGeneric,
  type GenericDataModel,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

export const query = queryGeneric as any;
export const mutation = mutationGeneric as any;
export const action = actionGeneric as any;
export const httpAction = httpActionGeneric as any;
export const internalQuery = internalQueryGeneric as any;
export const internalMutation = internalMutationGeneric as any;
export const internalAction = internalActionGeneric as any;
export const components = componentsGeneric as any;
