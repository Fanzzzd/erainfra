import { execa } from "execa";

export type ProfileSpec = {
  profile: string;
  executor: "docker" | "firecracker" | "tart" | "hyperv";
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
};

export type ReadinessResult = { state: "ready" } | { state: "failed"; error: string };

function dockerCacheVolume(profile: string) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile)) {
    throw new Error(`Profile ${profile} cannot be used as a Docker volume name`);
  }
  return `runner-center-${profile}-pnpm`;
}

export async function prepareProfile(profile: ProfileSpec): Promise<ReadinessResult> {
  try {
    switch (profile.executor) {
      case "docker": {
        await execa("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 });
        await execa("docker", ["pull", profile.imageRelease], { timeout: 60 * 60_000 });
        await execa("docker", ["image", "inspect", profile.imageRelease], { timeout: 30_000 });
        const cache = dockerCacheVolume(profile.profile);
        await execa("docker", [
          "volume",
          "create",
          "--label",
          `runner-center.profile=${profile.profile}`,
          "--label",
          "runner-center.cache=pnpm",
          cache,
        ]);
        await execa(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--user",
            "root",
            "--mount",
            `type=volume,src=${cache},dst=/runner-cache/pnpm`,
            profile.imageRelease,
            "/bin/chown",
            "-R",
            "runner:docker",
            "/runner-cache/pnpm",
          ],
          { timeout: 5 * 60_000 },
        );
        break;
      }
      case "firecracker": {
        const binary = process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime";
        await execa(binary, ["preflight"], { timeout: 60_000 });
        await execa(binary, ["prepare"], {
          env: { ...process.env, RC_IMAGE_RELEASE: profile.imageRelease },
          timeout: 60 * 60_000,
        });
        break;
      }
      case "tart": {
        const binary = process.env.TART?.trim() || "/opt/homebrew/bin/tart";
        await execa(binary, ["--version"], { timeout: 30_000 });
        // A digest reference makes this an idempotent prewarm, not an update.
        await execa(binary, ["pull", profile.imageRelease], { timeout: 2 * 60 * 60_000 });
        break;
      }
      case "hyperv":
        throw new Error(
          "Hyper-V remains preview-only until a Windows Worker passes live validation",
        );
    }
    return { state: "ready" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "failed", error: message.slice(0, 1_000) };
  }
}
