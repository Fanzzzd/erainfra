import type { ServiceSpec } from './models.ts';

export function renderNomadJob(input: {
  project: string;
  environment: string;
  service: ServiceSpec;
  datacenters?: string[];
}): string {
  const service = input.service;
  const jobName = `${input.project}-${input.environment}-${service.name}`;
  const portLabel = service.type === 'web' ? 'http' : 'app';
  const healthPath = service.healthPath ?? '/health';
  const port = service.port ?? 8080;

  return `job "${jobName}" {
  datacenters = [${(input.datacenters ?? ['dc1']).map((dc) => `"${dc}"`).join(', ')}]
  type        = "service"

  group "${service.name}" {
    count = ${service.replicas}

    update {
      max_parallel      = 1
      min_healthy_time  = "10s"
      healthy_deadline  = "2m"
      progress_deadline = "5m"
      auto_revert       = true
    }

    network {
      port "${portLabel}" {
        to = ${port}
      }
    }

    service {
      name = "${service.name}"
      port = "${portLabel}"
      tags = ["project=${input.project}", "env=${input.environment}"]

      check {
        type     = "http"
        path     = "${healthPath}"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "${service.name}" {
      driver = "docker"

      config {
        image = "${service.image}"
        ports = ["${portLabel}"]
      }

      resources {
        cpu    = ${Math.max(50, service.cpu)}
        memory = ${Math.max(64, service.memoryMb)}
      }
    }
  }
}
`;
}
