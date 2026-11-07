#!/usr/bin/env node
/**
 * 最终审计安全回归运行器。
 *
 * 固定字面量 allowlist；每个入口用当前 node 独立进程、串行执行，spawnSync 超时 60 秒；
 * 子进程只继承最小系统环境，不继承 HANA_*、token、NODE_OPTIONS 等。
 * 只终止超时的直接子进程，不做进程树清理、taskkill、删除或浏览器操作。
 *
 * 用法：
 *   node tests/support/run-audit-safe-tests.mjs --list        # 逐行打印清单，末行 count=N
 *   node tests/support/run-audit-safe-tests.mjs --manifest    # 打印清单与豁免名单（JSON），不跑测试
 *   node tests/support/run-audit-safe-tests.mjs              # 串行跑清单里的每个入口
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIMEOUT_MS = 60_000;

// 纯离线用例的统一分组理由（明细见下方 OFFLINE 块）。
const OFFLINE = '纯离线用例：无子进程、无端口、无真实网络（fetch 打桩、定时器用假时钟）；不在既有快速子集内，本轮不扩张门禁，可后续按裁决纳入';

// 当前 109 个入口（条数以 `--list` 末尾的 count= 为准，改名单时顺手对一下这行）：
// baseline + 历次已审查的旧入口 + 各轮新增审计入口 + Luna 的
// audit_web_async_regressions + 自我登记的 tests/audit_manifest_sync.test.mjs，是一个人工
// 维护的固定子集（不等于 scripts/run-all-tests.mjs 的目录自动发现：那边收录全部
// tests/*.test.mjs）。名单按仓库的 .sort() 顺序排（UTF-16：'-' < '.' < '_'），新增测试
// 文件必须显式加进来，否则不会被审计门禁跑到。
// 运行时不读取 summary，也不扫描 tests/ 目录。
//
// 门禁定位是「快速、离线、稳定」的固定子集，不是全量跑：2026-11 有一次把清单从 107 条扩到
// 156 条（几乎整目录，含要起网关、单例 20~40 秒的用例），整段被回退。所以未纳入门禁的文件
// 一律登记在下面的 EXEMPTIONS 里并写明分组理由，而不是塞进 ALLOWLIST。
// `tests/audit_manifest_sync.test.mjs` 负责盯住这件事：磁盘上每个 tests/*.test.mjs 必须
// 出现在 ALLOWLIST 或 EXEMPTIONS 里，两边的死条目/重复项/排序问题都会让它变红。
const ALLOWLIST = Object.freeze([
  'tests/abort_pending.test.mjs',
  'tests/action_confirmation.test.mjs',
  'tests/active_session_action_mutation.test.mjs',
  'tests/android_back_features.test.mjs',
  'tests/android_back_history.test.mjs',
  'tests/android_security.test.mjs',
  'tests/android_shell.test.mjs',
  'tests/archive_feature.test.mjs',
  'tests/attach.test.mjs',
  'tests/attach_concurrency.test.mjs',
  'tests/attach_files.test.mjs',
  'tests/audit_android_destroy.test.mjs',
  'tests/audit_android_download_name.test.mjs',
  'tests/audit_android_manifest.test.mjs',
  'tests/audit_gateway_filename.test.mjs',
  'tests/audit_gateway_owner_cut.test.mjs',
  'tests/audit_gateway_ws_backpressure.test.mjs',
  'tests/audit_gateway_ws_handshake.test.mjs',
  'tests/audit_manifest_sync.test.mjs',
  'tests/audit_web_async_regressions.test.mjs',
  'tests/avatar_view.test.mjs',
  'tests/back_entry.test.mjs',
  'tests/bugs_regression.test.mjs',
  'tests/build_sdk_selection.test.mjs',
  'tests/card_bridge.test.mjs',
  'tests/card_controller.test.mjs',
  'tests/card_document_channel.test.mjs',
  'tests/card_package_reference.test.mjs',
  'tests/card_runtime.test.mjs',
  'tests/casual_client.test.mjs',
  'tests/casual_integration.test.mjs',
  'tests/casual_stickers.test.mjs',
  'tests/casual_store.test.mjs',
  'tests/casual_view.test.mjs',
  'tests/chat_renderer_history_live.test.mjs',
  'tests/chat_renderer_serene.test.mjs',
  'tests/chat_view_mode.test.mjs',
  'tests/chat_view_mode_integration.test.mjs',
  'tests/composer_controller.test.mjs',
  'tests/composer_ime.test.mjs',
  'tests/conversation_new_session.test.mjs',
  'tests/css_structure.test.mjs',
  'tests/css_vars.test.mjs',
  'tests/devtools_attach_cleanup.test.mjs',
  // 产物哈希与缓存分级：只起本机 loopback 静态服务 + 跑两次构建，不碰真网关也不开浏览器。
  'tests/dist_cache.test.mjs',
  'tests/features_registry.test.mjs',
  'tests/file_preview_generation.test.mjs',
  'tests/file_source.test.mjs',
  'tests/gateway-boundary.test.mjs',
  'tests/gateway-owner-session.test.mjs',
  'tests/gateway-routing.test.mjs',
  'tests/gateway_launcher_ownership.test.mjs',
  'tests/gateway_process_identity.test.mjs',
  'tests/gateway_stop_mock.test.mjs',
  'tests/gateway_tunnel_config_precedence.test.mjs',
  'tests/gateway_tunnel_detach.test.mjs',
  'tests/harness_dom.test.mjs',
  'tests/history_pager.test.mjs',
  'tests/history_pager_busy_kind.test.mjs',
  'tests/history_pager_retry.test.mjs',
  'tests/history_pagination_integration.test.mjs',
  'tests/history_pagination_view.test.mjs',
  'tests/history_reload.test.mjs',
  'tests/home_attach.test.mjs',
  'tests/home_send_reliability.test.mjs',
  'tests/http_client.test.mjs',
  'tests/keyboard_scroll.test.mjs',
  'tests/login_controller.test.mjs',
  'tests/login_integration.test.mjs',
  'tests/login_view.test.mjs',
  'tests/logout_features_cleanup.test.mjs',
  'tests/md.test.mjs',
  'tests/md_quote.test.mjs',
  'tests/message_actions.test.mjs',
  'tests/message_search.test.mjs',
  'tests/mobile_integration.test.mjs',
  'tests/module_preload.test.mjs',
  'tests/mood_event.test.mjs',
  'tests/native_bridge.test.mjs',
  'tests/new_session_label.test.mjs',
  'tests/new_session_single_flight.test.mjs',
  'tests/notifications.test.mjs',
  'tests/protocol.test.mjs',
  'tests/reference_block.test.mjs',
  'tests/search_metadata_contract.test.mjs',
  'tests/send_controller.test.mjs',
  'tests/send_race.test.mjs',
  'tests/session_actions.test.mjs',
  'tests/session_file_download.test.mjs',
  'tests/session_list_controller.test.mjs',
  'tests/session_list_view.test.mjs',
  'tests/session_namespace_integration.test.mjs',
  'tests/session_namespace_tabs.test.mjs',
  'tests/settings_controller.test.mjs',
  'tests/settings_navigation_integration.test.mjs',
  'tests/settings_view.test.mjs',
  'tests/stream_state.test.mjs',
  'tests/stream_stats_timing.test.mjs',
  'tests/subagent_avatar.test.mjs',
  'tests/subagent_bar.test.mjs',
  'tests/subagent_sheet.test.mjs',
  'tests/subagent_transcript.test.mjs',
  'tests/subagent_view.test.mjs',
  'tests/theme.test.mjs',
  'tests/turn_summary.test.mjs',
  'tests/web_bundle.test.mjs',
  'tests/workspace_roots_integration.test.mjs',
  'tests/workspace_safe_area.test.mjs',
  'tests/workspace_service.test.mjs',
  'tests/workspace_view.test.mjs',
  'tests/ws_reconnect_generation.test.mjs',
]);

// 未纳入审计门禁的 tests/*.test.mjs，逐个登记；reason 必须写清「为什么不能进快速离线门禁」。
// 分组只是给人看的，条目按分组排、不参与 `.sort()` 校验；ALLOWLIST 才要求排序。
// 理由依据：静态检查各文件的 import / spawn / 端口监听 / 硬编码浏览器路径 / 本机工具链依赖。
const EXEMPTIONS = Object.freeze([
  // 需要真实网关子进程与本机端口（spawn node gateway + 本机 net/http 上游）。
  // 这类用例要等端口就绪、进程退出，单例耗时与环境耦合，不进快速门禁。
  { file: 'tests/feed_gateway.test.mjs', reason: '需要真实网关子进程与本机端口上游（spawn gateway + net/http 假上游）' },
  { file: 'tests/gateway_auth_abort.test.mjs', reason: '需要真实网关子进程与本机端口上游（spawn server + net/http 假上游）' },
  { file: 'tests/gateway-card-token.test.mjs', reason: '需要真实网关子进程与本机端口上游，另含真实 Chromium sandbox iframe 探针' },
  { file: 'tests/gateway-config-input.test.mjs', reason: '需要真实网关子进程，且依赖 PowerShell（pwsh 跑 start.ps1 -CheckOnly）' },
  { file: 'tests/gateway_file_streaming.test.mjs', reason: '依赖本机端口 HTTP 上游与网关转发链路（http.createServer/listen + upstream）' },
  { file: 'tests/gateway-path-cookie.test.mjs', reason: '需要真实网关子进程与本机端口上游（spawn server + net/http 假上游）' },
  { file: 'tests/gateway-proxy-lifecycle.test.mjs', reason: '需要真实网关子进程与本机端口上游（进程生命周期与端口释放都要等）' },
  { file: 'tests/gateway-security.test.mjs', reason: '需要真实网关子进程与本机端口（鉴权/越权路径要起进程、等端口）' },
  { file: 'tests/gateway-supervise.test.mjs', reason: '需要真实子进程与 Windows 进程管理（cmd.exe 起监督脚本 + taskkill 按 PID 终止 + 时间窗探针）' },

  // 需要本机真实浏览器（硬编码 Chrome/Edge 路径或无头调试端口）。
  { file: 'tests/composer_layout.test.mjs', reason: '需要本机 Edge（硬编码 msedge.exe 路径）跑真实浏览器视口回归' },
  { file: 'tests/feed_entry_layout.test.mjs', reason: '需要本机 Chrome/Edge 跑真实布局回归（找 exe + 无头调试端口 + 本机服务）' },
  { file: 'tests/feed_full_reader_browser.test.mjs', reason: '需要本机 Chrome/Edge 跑真实浏览器阅读层验收（无头调试端口 + 本机服务）' },
  { file: 'tests/layout_diagnostic.test.mjs', reason: '需要本机 Edge（硬编码 msedge.exe 路径）跑布局诊断' },
  { file: 'tests/user_media_alignment.test.mjs', reason: '需要本机 Edge（硬编码 msedge.exe 路径）与调试端口跑真实媒体对齐回归' },

  // 依赖 PowerShell 与网络/本机工具链脚本。
  { file: 'tests/autostart.test.mjs', reason: '依赖 PowerShell（spawnSync pwsh -File 跑自启脚本探针）' },
  { file: 'tests/release_preflight.test.mjs', reason: '依赖 PowerShell（pwsh.exe 跑 scripts/release.ps1 与 android/build.ps1）及假 JDK/Android 工具链' },

  // 需要真机/Android SDK 或本机 JDK 工具链。
  { file: 'tests/devtools_dry_run.test.mjs', reason: 'Android devtools 链路：起本机 HTTP/WS 服务并 spawn UI 探针子进程 + 假 adb' },
  { file: 'tests/url_guard.test.mjs', reason: '依赖本机 JDK（javac/java 编译并执行 Android 侧纯 Java 探针）' },

  // 自身是聚合 runner 的用例：再套审计门禁会嵌套起全量测试。
  { file: 'tests/run_all_contract.test.mjs', reason: '要 spawn scripts/run-all-tests.mjs 全量 runner，属嵌套聚合，不适合再套门禁' },
  { file: 'tests/run_all_timeout.test.mjs', reason: '要 spawn 全量 runner 并验证超时/进程树清理，自带真实超时等待与子进程终止' },

  // 纯离线用例：无子进程、无端口、无真实网络（fetch 全部打桩，定时器用假时钟）。
  // 它们不是「跑不动」，而是不在既有 108 条快速子集里；本轮按轻量策略不扩张门禁，
  // 需要时再按主控裁决逐条纳入（届时只从 EXEMPTIONS 移到 ALLOWLIST）。
  { file: 'tests/agent_label.test.mjs', reason: OFFLINE },
  { file: 'tests/card_first_frame.test.mjs', reason: OFFLINE },
  { file: 'tests/code_copy.test.mjs', reason: OFFLINE },
  { file: 'tests/code_folder_picker.test.mjs', reason: OFFLINE },
  { file: 'tests/code_panel.test.mjs', reason: OFFLINE },
  { file: 'tests/connection_banner.test.mjs', reason: OFFLINE },
  { file: 'tests/draft_store.test.mjs', reason: OFFLINE },
  { file: 'tests/draft_wiring.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_client.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_controller.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_conversation.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_full_reader.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_integration.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_read_tracker.test.mjs', reason: OFFLINE },
  { file: 'tests/feed_view.test.mjs', reason: OFFLINE },
  { file: 'tests/file_preview_navigation.test.mjs', reason: OFFLINE },
  { file: 'tests/foreground_resume.test.mjs', reason: OFFLINE },
  { file: 'tests/gateway_logger.test.mjs', reason: OFFLINE },
  { file: 'tests/image_viewer_wiring.test.mjs', reason: OFFLINE },
  { file: 'tests/lightbox.test.mjs', reason: OFFLINE },
  { file: 'tests/message_actions_quote.test.mjs', reason: OFFLINE },
  { file: 'tests/outbox.test.mjs', reason: OFFLINE },
  { file: 'tests/pending_state.test.mjs', reason: OFFLINE },
  { file: 'tests/quote_bar.test.mjs', reason: OFFLINE },
  { file: 'tests/quote_consumption.test.mjs', reason: OFFLINE },
  { file: 'tests/quote_wiring.test.mjs', reason: OFFLINE },
  { file: 'tests/scroll_memory.test.mjs', reason: OFFLINE },
  { file: 'tests/scroll_pin.test.mjs', reason: OFFLINE },
  { file: 'tests/serene_ops.test.mjs', reason: OFFLINE },
  { file: 'tests/thinking_refresh_after_switch.test.mjs', reason: OFFLINE },
  { file: 'tests/toast.test.mjs', reason: OFFLINE },
  { file: 'tests/turn_segment.test.mjs', reason: OFFLINE },
  { file: 'tests/ws_ready_ui.test.mjs', reason: OFFLINE },
  { file: 'tests/ws_status.test.mjs', reason: OFFLINE },
]);

const ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'JAVA_HOME'];

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  for (const file of ALLOWLIST) console.log(file);
  console.log(`count=${ALLOWLIST.length}`);
  process.exit(0);
}
if (args.length === 1 && args[0] === '--manifest') {
  // 只读出口：给 tests/audit_manifest_sync.test.mjs 用，不跑任何测试。
  console.log(JSON.stringify({
    allowlist: [...ALLOWLIST],
    exemptions: EXEMPTIONS.map((entry) => ({ ...entry })),
    allowlistCount: ALLOWLIST.length,
    exemptionsCount: EXEMPTIONS.length,
  }, null, 2));
  process.exit(0);
}
if (args.length > 0) {
  console.error('usage: node tests/support/run-audit-safe-tests.mjs [--list | --manifest]');
  process.exit(2);
}

const env = {};
for (const key of ENV_KEYS) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

const artifacts = path.join(ROOT, 'tests', 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const logDir = fs.mkdtempSync(path.join(artifacts, `audit-final-logs-${stamp}-`));
const results = [];
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, ERROR: 0 };
console.log(`logDir=${logDir}`);

for (const file of ALLOWLIST) {
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [path.join(ROOT, file)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - startedAt;

  let status;
  let error = null;
  if (run.error?.code === 'ETIMEDOUT') {
    status = 'TIMEOUT';
    error = `timeout after ${TIMEOUT_MS}ms`;
  } else if (run.error) {
    status = 'ERROR';
    error = run.error.message;
  } else if (run.status === 0) {
    status = 'PASS';
  } else {
    status = 'FAIL';
    error = run.signal ? `signal ${run.signal}` : `exit code ${run.status}`;
  }

  const log = path.join(logDir, `${path.basename(file)}.log`);
  fs.writeFileSync(
    log,
    [
      `file: ${file}`,
      `command: ${process.execPath} ${path.join(ROOT, file)}`,
      `cwd: ${ROOT}`,
      `timeoutMs: ${TIMEOUT_MS}`,
      `status: ${status}`,
      `exitCode: ${run.status}`,
      `signal: ${run.signal ?? ''}`,
      `elapsedMs: ${elapsedMs}`,
      `error: ${error ?? ''}`,
      '',
      '--- stdout ---',
      run.stdout ?? '',
      '',
      '--- stderr ---',
      run.stderr ?? '',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = { file, status, exitCode: run.status, error, elapsedMs, log };
  results.push(result);
  counts[status] += 1;
  console.log(`${status} ${file} (${elapsedMs}ms)`);
}

const summary = {
  root: ROOT,
  logDir,
  timeoutMs: TIMEOUT_MS,
  allowlistCount: ALLOWLIST.length,
  executedCount: results.length,
  counts,
  results,
};
fs.writeFileSync(path.join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`summary=${path.join(logDir, 'summary.json')}`);
console.log(`PASS=${counts.PASS} FAIL=${counts.FAIL} TIMEOUT=${counts.TIMEOUT} ERROR=${counts.ERROR}`);
if (counts.PASS !== results.length) process.exitCode = 1;
