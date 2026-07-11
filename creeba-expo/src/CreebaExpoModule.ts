import { requireNativeModule } from "expo-modules-core";
import type { CreebaExpoNativeModule } from "./CreebaExpo.types.ts";

/**
 * Native module instance. `requireNativeModule` throws an explicit error if the
 * native side is not linked (e.g. running under Expo Go, without a dev build).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
export const CreebaExpoModule =
  requireNativeModule<CreebaExpoNativeModule>("CreebaExpo");
