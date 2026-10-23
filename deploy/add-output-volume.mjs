// Adds an Azure Files volume + mount to an exported Container App definition (az containerapp show -o json).
// JSON is valid YAML, so the patched file can go straight into `az containerapp update --yaml`.
// Usage: node deploy/add-output-volume.mjs <app.json> <envStorageName> <mountPath>
// Exit codes: 0 = file patched, 3 = volume already mounted (nothing to do), 1 = error.
import { readFileSync, writeFileSync } from "node:fs";

const [file, storageName, mountPath] = process.argv.slice(2);
if (!file || !storageName || !mountPath) {
  console.error("usage: add-output-volume.mjs <app.json> <envStorageName> <mountPath>");
  process.exit(1);
}

const VOLUME = "output";
// The image runs as the "node" user (uid/gid 1000); SMB mounts are owned by root unless told otherwise.
const MOUNT_OPTIONS = "uid=1000,gid=1000,dir_mode=0755,file_mode=0644";

const app = JSON.parse(readFileSync(file, "utf8"));
const template = app.properties?.template;
const container = template?.containers?.[0];
if (!container) {
  console.error("No containers found in the exported definition");
  process.exit(1);
}

const volumes = template.volumes ?? [];
const mounts = container.volumeMounts ?? [];
const hasVolume = volumes.some((v) => v.name === VOLUME && v.storageName === storageName && v.mountOptions === MOUNT_OPTIONS);
const hasMount = mounts.some((m) => m.volumeName === VOLUME && m.mountPath === mountPath);
if (hasVolume && hasMount) process.exit(3);

template.volumes = [
  ...volumes.filter((v) => v.name !== VOLUME),
  { name: VOLUME, storageType: "AzureFile", storageName, mountOptions: MOUNT_OPTIONS },
];
container.volumeMounts = [...mounts.filter((m) => m.volumeName !== VOLUME && m.mountPath !== mountPath), { volumeName: VOLUME, mountPath }];

writeFileSync(file, JSON.stringify(app, null, 2));
