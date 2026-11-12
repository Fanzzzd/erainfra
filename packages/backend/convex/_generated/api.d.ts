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
import type * as agentRelease from "../agentRelease.js";
import type * as alertDelivery from "../alertDelivery.js";
import type * as alertNotify from "../alertNotify.js";
import type * as alertRules from "../alertRules.js";
import type * as alerts from "../alerts.js";
import type * as apiTokenPolicy from "../apiTokenPolicy.js";
import type * as apiTokens from "../apiTokens.js";
import type * as attemptMetrics from "../attemptMetrics.js";
import type * as attemptMetricsModel from "../attemptMetricsModel.js";
import type * as attemptScheduler from "../attemptScheduler.js";
import type * as attemptSecrets from "../attemptSecrets.js";
import type * as attempts from "../attempts.js";
import type * as auth from "../auth.js";
import type * as authPolicy from "../authPolicy.js";
import type * as benchmark from "../benchmark.js";
import type * as bootstrap from "../bootstrap.js";
import type * as bootstrapPolicy from "../bootstrapPolicy.js";
import type * as catalog from "../catalog.js";
import type * as controllerApi from "../controllerApi.js";
import type * as controllerGithubToken from "../controllerGithubToken.js";
import type * as controllerHttp from "../controllerHttp.js";
import type * as controllerLease from "../controllerLease.js";
import type * as controllerLiveness from "../controllerLiveness.js";
import type * as crons from "../crons.js";
import type * as dashboardAuth from "../dashboardAuth.js";
import type * as egress from "../egress.js";
import type * as experiments from "../experiments.js";
import type * as fleetObservation from "../fleetObservation.js";
import type * as github from "../github.js";
import type * as githubApp from "../githubApp.js";
import type * as githubAppConfig from "../githubAppConfig.js";
import type * as hostLabels from "../hostLabels.js";
import type * as http from "../http.js";
import type * as infra_access from "../infra/access.js";
import type * as infra_apps from "../infra/apps.js";
import type * as infra_audit from "../infra/audit.js";
import type * as infra_auditLog from "../infra/auditLog.js";
import type * as infra_counters from "../infra/counters.js";
import type * as infra_deployments from "../infra/deployments.js";
import type * as infra_git from "../infra/git.js";
import type * as infra_hubPassword from "../infra/hubPassword.js";
import type * as infra_ingress from "../infra/ingress.js";
import type * as infra_leases from "../infra/leases.js";
import type * as infra_nodes from "../infra/nodes.js";
import type * as infra_policy from "../infra/policy.js";
import type * as infra_ports from "../infra/ports.js";
import type * as infra_secretCrypto from "../infra/secretCrypto.js";
import type * as infra_secrets from "../infra/secrets.js";
import type * as infra_tables from "../infra/tables.js";
import type * as infra_dockerArgs from "../infra/dockerArgs.js";
import type * as infra_nodeCommandModel from "../infra/nodeCommandModel.js";
import type * as infra_nodeCommands from "../infra/nodeCommands.js";
import type * as infra_nodeHttp from "../infra/nodeHttp.js";
import type * as infra_nodeState from "../infra/nodeState.js";
import type * as infra_deployApi from "../infra/deployApi.js";
import type * as infra_deployHttp from "../infra/deployHttp.js";
import type * as infra_failover from "../infra/failover.js";
import type * as infra_githubDeploy from "../infra/githubDeploy.js";
import type * as infra_pipeline from "../infra/pipeline.js";
import type * as infra_plan from "../infra/plan.js";
import type * as infra_spec from "../infra/spec.js";
import type * as infra_logs from "../infra/logs.js";
import type * as infra_logOutput from "../infra/logOutput.js";
import type * as infra_operator from "../infra/operator.js";
import type * as infra_operatorRoutes from "../infra/operatorRoutes.js";
import type * as infra_operatorGit from "../infra/operatorGit.js";
import type * as infra_operatorGitRoutes from "../infra/operatorGitRoutes.js";
import type * as infra_relayAccess from "../infra/relayAccess.js";
import type * as installScript from "../installScript.js";
import type * as installScriptPowerShell from "../installScriptPowerShell.js";
import type * as isolation from "../isolation.js";
import type * as jobs from "../jobs.js";
import type * as machines from "../machines.js";
import type * as metrics from "../metrics.js";
import type * as metricsFormat from "../metricsFormat.js";
import type * as operatorApi from "../operatorApi.js";
import type * as operatorHttp from "../operatorHttp.js";
import type * as operatorTestsHttp from "../operatorTestsHttp.js";
import type * as policy from "../policy.js";
import type * as profiles from "../profiles.js";
import type * as reconcile from "../reconcile.js";
import type * as recovery from "../recovery.js";
import type * as retry from "../retry.js";
import type * as rightsize from "../rightsize.js";
import type * as rightsizeModel from "../rightsizeModel.js";
import type * as routerDecisions from "../routerDecisions.js";
import type * as routerDecisionsModel from "../routerDecisionsModel.js";
import type * as routing from "../routing.js";
import type * as runnerReleaseModel from "../runnerReleaseModel.js";
import type * as runnerReleases from "../runnerReleases.js";
import type * as runners from "../runners.js";
import type * as scheduler from "../scheduler.js";
import type * as settings from "../settings.js";
import type * as startBudget from "../startBudget.js";
import type * as startBudgetModel from "../startBudgetModel.js";
import type * as strandedJobs from "../strandedJobs.js";
import type * as strandedJobsModel from "../strandedJobsModel.js";
import type * as testReports from "../testReports.js";
import type * as testReportsModel from "../testReportsModel.js";
import type * as webhooks from "../webhooks.js";
import type * as workerApi from "../workerApi.js";
import type * as workerPolicy from "../workerPolicy.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agentApi: typeof agentApi;
  agentRelease: typeof agentRelease;
  alertDelivery: typeof alertDelivery;
  alertNotify: typeof alertNotify;
  alertRules: typeof alertRules;
  alerts: typeof alerts;
  apiTokenPolicy: typeof apiTokenPolicy;
  apiTokens: typeof apiTokens;
  attemptMetrics: typeof attemptMetrics;
  attemptMetricsModel: typeof attemptMetricsModel;
  attemptScheduler: typeof attemptScheduler;
  attemptSecrets: typeof attemptSecrets;
  attempts: typeof attempts;
  auth: typeof auth;
  authPolicy: typeof authPolicy;
  benchmark: typeof benchmark;
  bootstrap: typeof bootstrap;
  bootstrapPolicy: typeof bootstrapPolicy;
  catalog: typeof catalog;
  controllerApi: typeof controllerApi;
  controllerGithubToken: typeof controllerGithubToken;
  controllerHttp: typeof controllerHttp;
  controllerLease: typeof controllerLease;
  controllerLiveness: typeof controllerLiveness;
  crons: typeof crons;
  dashboardAuth: typeof dashboardAuth;
  egress: typeof egress;
  experiments: typeof experiments;
  fleetObservation: typeof fleetObservation;
  github: typeof github;
  githubApp: typeof githubApp;
  githubAppConfig: typeof githubAppConfig;
  hostLabels: typeof hostLabels;
  http: typeof http;
  "infra/access": typeof infra_access;
  "infra/apps": typeof infra_apps;
  "infra/audit": typeof infra_audit;
  "infra/auditLog": typeof infra_auditLog;
  "infra/counters": typeof infra_counters;
  "infra/deployments": typeof infra_deployments;
  "infra/git": typeof infra_git;
  "infra/hubPassword": typeof infra_hubPassword;
  "infra/ingress": typeof infra_ingress;
  "infra/leases": typeof infra_leases;
  "infra/nodes": typeof infra_nodes;
  "infra/policy": typeof infra_policy;
  "infra/ports": typeof infra_ports;
  "infra/secretCrypto": typeof infra_secretCrypto;
  "infra/secrets": typeof infra_secrets;
  "infra/tables": typeof infra_tables;
  "infra/dockerArgs": typeof infra_dockerArgs;
  "infra/nodeCommandModel": typeof infra_nodeCommandModel;
  "infra/nodeCommands": typeof infra_nodeCommands;
  "infra/nodeHttp": typeof infra_nodeHttp;
  "infra/nodeState": typeof infra_nodeState;
  "infra/deployApi": typeof infra_deployApi;
  "infra/deployHttp": typeof infra_deployHttp;
  "infra/failover": typeof infra_failover;
  "infra/githubDeploy": typeof infra_githubDeploy;
  "infra/pipeline": typeof infra_pipeline;
  "infra/plan": typeof infra_plan;
  "infra/spec": typeof infra_spec;
  "infra/logs": typeof infra_logs;
  "infra/logOutput": typeof infra_logOutput;
  "infra/operator": typeof infra_operator;
  "infra/operatorRoutes": typeof infra_operatorRoutes;
  "infra/operatorGit": typeof infra_operatorGit;
  "infra/operatorGitRoutes": typeof infra_operatorGitRoutes;
  "infra/relayAccess": typeof infra_relayAccess;
  installScript: typeof installScript;
  installScriptPowerShell: typeof installScriptPowerShell;
  isolation: typeof isolation;
  jobs: typeof jobs;
  machines: typeof machines;
  metrics: typeof metrics;
  metricsFormat: typeof metricsFormat;
  operatorApi: typeof operatorApi;
  operatorHttp: typeof operatorHttp;
  operatorTestsHttp: typeof operatorTestsHttp;
  policy: typeof policy;
  profiles: typeof profiles;
  reconcile: typeof reconcile;
  recovery: typeof recovery;
  retry: typeof retry;
  rightsize: typeof rightsize;
  rightsizeModel: typeof rightsizeModel;
  routerDecisions: typeof routerDecisions;
  routerDecisionsModel: typeof routerDecisionsModel;
  routing: typeof routing;
  runnerReleaseModel: typeof runnerReleaseModel;
  runnerReleases: typeof runnerReleases;
  runners: typeof runners;
  scheduler: typeof scheduler;
  settings: typeof settings;
  startBudget: typeof startBudget;
  startBudgetModel: typeof startBudgetModel;
  strandedJobs: typeof strandedJobs;
  strandedJobsModel: typeof strandedJobsModel;
  testReports: typeof testReports;
  testReportsModel: typeof testReportsModel;
  webhooks: typeof webhooks;
  workerApi: typeof workerApi;
  workerPolicy: typeof workerPolicy;
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
