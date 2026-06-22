export interface TunnelRoute {
  hostname: string;
  serviceUrl: string;
}

export function renderCloudflaredConfig(input: {
  tunnelId: string;
  credentialsFile: string;
  routes: TunnelRoute[];
}): string {
  const ingress = input.routes
    .map((route) => `  - hostname: ${route.hostname}\n    service: ${route.serviceUrl}`)
    .join('\n');

  return `tunnel: ${input.tunnelId}
credentials-file: ${input.credentialsFile}

ingress:
${ingress}
  - service: http_status:404
`;
}
