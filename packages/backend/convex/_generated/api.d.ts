/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agentApi from "../agentApi.js";
import type * as auth from "../auth.js";
import type * as catalog from "../catalog.js";
import type * as crons from "../crons.js";
import type * as github from "../github.js";
import type * as githubApp from "../githubApp.js";
import type * as githubAppConfig from "../githubAppConfig.js";
import type * as http from "../http.js";
import type * as installScript from "../installScript.js";
import type * as jobs from "../jobs.js";
import type * as machines from "../machines.js";
import type * as reconcile from "../reconcile.js";
import type * as scheduler from "../scheduler.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agentApi: typeof agentApi;
  auth: typeof auth;
  catalog: typeof catalog;
  crons: typeof crons;
  github: typeof github;
  githubApp: typeof githubApp;
  githubAppConfig: typeof githubAppConfig;
  http: typeof http;
  installScript: typeof installScript;
  jobs: typeof jobs;
  machines: typeof machines;
  reconcile: typeof reconcile;
  scheduler: typeof scheduler;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
