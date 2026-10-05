import 'server-only';
import { storageFromEnv, type Storage } from '@solar/integrations';

let storage: Storage | undefined;

export function getStorage(): Storage {
  storage ??= storageFromEnv();
  return storage;
}
