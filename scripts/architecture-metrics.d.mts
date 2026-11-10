// scripts/architecture-metrics.mjs 的型別宣告（給 prototype/ambient-shell/tests/architecture.test.ts 的型別檢查用）。
// Type declarations for scripts/architecture-metrics.mjs (used when type-checking the architecture guard test).
export type Layer = "server" | "shared" | "src" | "desktop";
export const DEFAULT_SHELL_DIR: string;
export const LAYERS: readonly Layer[];
export const ALLOWED_IMPORTS: Readonly<Record<Layer, readonly Layer[]>>;
export const LINE_LIMIT: number;

export interface ImportGraph {
  source_files: number;
  total_loc: number;
  by_layer: Partial<Record<Layer, { files: number; loc: number }>>;
  /** [相對路徑, 行數]，行數多的在前。 */
  files_over_800_lines: [file: string, lines: number][];
  top_fan_out: [file: string, count: number][];
  top_fan_in: [file: string, count: number][];
  /** 每筆是 "from -> to"。 */
  cross_layer_imports: string[];
  /** 每組是一個強連通分量（兩個檔以上），組內已排序。 */
  import_cycles: string[][];
  known: Set<string>;
  text: Map<string, string>;
}

export interface ArchitectureMetrics extends Omit<ImportGraph, "known" | "text"> {
  measured_at: string;
  http_routes: { app_ts_path_matches: number; voice_relay_cases: number; note: string };
  settings_writers: { own_tmp_rename_files: string[]; prefs_file_users: string[] };
  app_ts_repeats: { localize_settings_view_lines: number; same_save_error_message: number };
  realtime_page_duplicate_private_methods: string[];
  tests: {
    files: number;
    classes: { desktop: number; server_http: number; page_dom: number; fixture: number; pure: number };
    dom_environment_installed: boolean;
    modules_without_direct_test_import: string[];
  };
}

export function collectImportGraph(shellDir?: string): ImportGraph;
export function collectMetrics(shellDir?: string): ArchitectureMetrics;
