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

// 当前 175 个入口（条数以 `--list` 末尾的 count= 为准，改名单时顺手对一下这行）：
// baseline + 历次已审查的旧入口 + 各轮新增审计入口 + Luna 的
// audit_web_async_regressions + 自我登记的 tests/audit_manifest_sync.test.mjs，是一个人工
// 维护的固定子集（不等于 scripts/run-all-tests.mjs 的目录自动发现：那边收录全部
// tests/*.test.mjs）。名单按仓库的 .sort() 顺序排（UTF-16：'-' < '.' < '_'），新增测试
// 文件必须显式加进来，否则不会被审计门禁跑到。
// 运行时不读取 summary，也不扫描 tests/ 目录。
//
// I5-1：原 34 条 OFFLINE 豁免已逐个执行 `node tests/<file>`，本机 Win32 全部通过；静态检查未发现
// 真实进程、端口、浏览器、PowerShell/JDK 或外部网络依赖，网络/WebSocket 由夹具替身处理。
// 慢项实测单独说明：feed_integration 15.8s、foreground_resume 14.9s、draft_wiring 9.4s、
// file_preview_navigation 3.2s、ws_ready_ui 3.2s；34 条合计约 55s。保留在常规清单，实测旧清单
// 耗时为 212.8s，按直接实跑增量估算约 268s，低于 300s；未拆分或绕开门禁。
//
// 门禁定位是「快速、离线、稳定」的固定子集，不是全量跑：2026-11 有一次把清单从 107 条扩到
// 156 条（几乎整目录，含要起网关、单例 20~40 秒的用例），整段被回退。所以未纳入门禁的文件
// 一律登记在下面的 EXEMPTIONS 里并写明分组理由，而不是塞进 ALLOWLIST。
// `tests/audit_manifest_sync.test.mjs` 负责盯住这件事：磁盘上每个 tests/*.test.mjs 必须
// 出现在 ALLOWLIST 或 EXEMPTIONS 里，两边的死条目/重复项/排序问题都会让它变红。
const ALLOWLIST = Object.freeze([
  'tests/abort_pending.test.mjs',
  'tests/abort_queue.test.mjs',
  'tests/action_confirmation.test.mjs',
  'tests/active_session_action_mutation.test.mjs',
  'tests/agent_carousel.test.mjs',
  'tests/agent_label.test.mjs',
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
  'tests/avatar_cache.test.mjs',
  'tests/avatar_pack.test.mjs',
  'tests/avatar_pack_client.test.mjs',
  'tests/avatar_view.test.mjs',
  'tests/back_entry.test.mjs',
  'tests/bugs_regression.test.mjs',
  'tests/build_sdk_selection.test.mjs',
  'tests/card_bridge.test.mjs',
  'tests/card_controller.test.mjs',
  'tests/card_document_channel.test.mjs',
  'tests/card_first_frame.test.mjs',
  'tests/card_package_reference.test.mjs',
  'tests/card_runtime.test.mjs',
  'tests/casual_boot_badge.test.mjs',
  'tests/casual_client.test.mjs',
  'tests/casual_integration.test.mjs',
  'tests/casual_stickers.test.mjs',
  'tests/casual_store.test.mjs',
  'tests/casual_view.test.mjs',
  'tests/chat_panel.test.mjs',
  'tests/chat_renderer_history_live.test.mjs',
  'tests/chat_renderer_serene.test.mjs',
  'tests/chat_view_mode.test.mjs',
  'tests/chat_view_mode_integration.test.mjs',
  'tests/code_copy.test.mjs',
  'tests/code_folder_picker.test.mjs',
  'tests/code_panel.test.mjs',
  'tests/composer_controller.test.mjs',
  'tests/composer_ime.test.mjs',
  'tests/connection_banner.test.mjs',
  'tests/conversation_new_session.test.mjs',
  'tests/css_structure.test.mjs',
  'tests/css_vars.test.mjs',
  'tests/devtools_attach_cleanup.test.mjs',
  // 产物哈希与缓存分级：只起本机 loopback 静态服务 + 跑两次构建，不碰真网关也不开浏览器。
  'tests/dist_cache.test.mjs',
  'tests/draft_store.test.mjs',
  'tests/draft_wiring.test.mjs',
  'tests/echo_guard.test.mjs',
  'tests/features_registry.test.mjs',
  'tests/feed_client.test.mjs',
  'tests/feed_controller.test.mjs',
  'tests/feed_conversation.test.mjs',
  'tests/feed_full_reader.test.mjs',
  'tests/feed_integration.test.mjs',
  'tests/feed_read_tracker.test.mjs',
  'tests/feed_view.test.mjs',
  'tests/file_preview_generation.test.mjs',
  'tests/file_preview_navigation.test.mjs',
  'tests/file_roots_mounts.test.mjs',
  'tests/file_source.test.mjs',
  'tests/finished_notice.test.mjs',
  'tests/foreground_idle_reconcile.test.mjs',
  'tests/foreground_resume.test.mjs',
  'tests/gateway-boundary.test.mjs',
  'tests/gateway-owner-session.test.mjs',
  'tests/gateway-routing.test.mjs',
  'tests/gateway_compression.test.mjs',
  'tests/gateway_launcher_ownership.test.mjs',
  'tests/gateway_logger.test.mjs',
  'tests/gateway_process_identity.test.mjs',
  'tests/gateway_stop_mock.test.mjs',
  'tests/gateway_tunnel_config_precedence.test.mjs',
  'tests/gateway_tunnel_detach.test.mjs',
  'tests/gateway_ws_frame_log.test.mjs',
  'tests/harness_dom.test.mjs',
  'tests/history_pager.test.mjs',
  'tests/history_pager_busy_kind.test.mjs',
  'tests/history_pager_extra_query.test.mjs',
  'tests/history_pager_retry.test.mjs',
  'tests/history_pagination_integration.test.mjs',
  'tests/history_pagination_view.test.mjs',
  'tests/history_reload.test.mjs',
  'tests/home_attach.test.mjs',
  'tests/home_send_reliability.test.mjs',
  'tests/http_client.test.mjs',
  'tests/image_viewer_wiring.test.mjs',
  'tests/keyboard_scroll.test.mjs',
  'tests/lightbox.test.mjs',
  'tests/local_send_visibility.test.mjs',
  'tests/login_controller.test.mjs',
  'tests/login_integration.test.mjs',
  'tests/login_view.test.mjs',
  'tests/logout_features_cleanup.test.mjs',
  'tests/md.test.mjs',
  'tests/md_quote.test.mjs',
  'tests/message_actions.test.mjs',
  'tests/message_actions_quote.test.mjs',
  'tests/message_search.test.mjs',
  'tests/mobile_integration.test.mjs',
  'tests/module_preload.test.mjs',
  'tests/mood_event.test.mjs',
  'tests/native_bridge.test.mjs',
  'tests/native_bridge_share.test.mjs',
  'tests/new_session_label.test.mjs',
  'tests/new_session_single_flight.test.mjs',
  'tests/notifications.test.mjs',
  'tests/outbox.test.mjs',
  'tests/pdf_preview.test.mjs',
  'tests/pending_state.test.mjs',
  'tests/pptx_preview.test.mjs',
  'tests/protocol.test.mjs',
  'tests/quote_bar.test.mjs',
  'tests/quote_consumption.test.mjs',
  'tests/quote_wiring.test.mjs',
  'tests/reference_block.test.mjs',
  'tests/renderer_parts.test.mjs',
  'tests/renderer_state.test.mjs',
  'tests/scroll_memory.test.mjs',
  'tests/scroll_pin.test.mjs',
  'tests/search_jump.test.mjs',
  'tests/search_jump_assembly.test.mjs',
  'tests/search_metadata_contract.test.mjs',
  'tests/send_controller.test.mjs',
  'tests/send_race.test.mjs',
  'tests/serene_ops.test.mjs',
  'tests/session_actions.test.mjs',
  'tests/session_digest.test.mjs',
  'tests/session_file_download.test.mjs',
  'tests/session_file_read.test.mjs',
  'tests/session_list_controller.test.mjs',
  'tests/session_list_view.test.mjs',
  'tests/session_namespace_integration.test.mjs',
  'tests/session_namespace_tabs.test.mjs',
  'tests/session_panel.test.mjs',
  'tests/settings_controller.test.mjs',
  'tests/settings_navigation_integration.test.mjs',
  'tests/settings_panel.test.mjs',
  'tests/settings_view.test.mjs',
  'tests/stream_state.test.mjs',
  'tests/stream_stats_timing.test.mjs',
  'tests/subagent_avatar.test.mjs',
  'tests/subagent_bar.test.mjs',
  'tests/subagent_sheet.test.mjs',
  'tests/subagent_transcript.test.mjs',
  'tests/subagent_view.test.mjs',
  'tests/tail_cache.test.mjs',
  'tests/tail_serve.test.mjs',
  'tests/theme.test.mjs',
  'tests/thinking_refresh_after_switch.test.mjs',
  'tests/toast.test.mjs',
  'tests/turn_segment.test.mjs',
  'tests/turn_summary.test.mjs',
  'tests/version_mirror.test.mjs',
  'tests/web_bundle.test.mjs',
  'tests/workspace_roots_integration.test.mjs',
  'tests/workspace_safe_area.test.mjs',
  'tests/workspace_service.test.mjs',
  'tests/workspace_view.test.mjs',
  'tests/ws_ready_ui.test.mjs',
  'tests/ws_reconnect_generation.test.mjs',
  'tests/ws_status.test.mjs',
  'tests/xlsx_preview.test.mjs',
]);

// 未纳入审计门禁的 tests/*.test.mjs，逐个登记；reason 必须写清「为什么必须豁免」和「在哪个专项里跑」。
// 分组只是给人看的，条目按分组排、不参与 `.sort()` 校验；ALLOWLIST 才要求排序。
// 理由依据：真实子进程/端口、浏览器、PowerShell/JDK 或嵌套 runner，不能由离线夹具替代。
const EXEMPTIONS = Object.freeze([
  // 真实网关进程与本机端口：启动、等就绪、关闭的生命周期与机器/端口环境耦合。
  { file: 'tests/feed_gateway.test.mjs', reason: '必须豁免：要启动真实 gateway 子进程并绑定 loopback HTTP 假上游；专项任务：gateway HTTP integration' },
  { file: 'tests/gateway_auth_abort.test.mjs', reason: '必须豁免：要启动真实 server 子进程和 loopback HTTP 假上游；专项任务：gateway auth/abort integration' },
  { file: 'tests/gateway-card-token.test.mjs', reason: '必须豁免：需要真实 gateway 子进程、端口和 Chromium sandbox iframe 探针；专项任务：gateway card-token/browser security' },
  { file: 'tests/gateway-config-input.test.mjs', reason: '必须豁免：需要真实 gateway 子进程及 PowerShell 执行 start.ps1 -CheckOnly；专项任务：gateway config/PowerShell integration' },
  { file: 'tests/gateway_file_streaming.test.mjs', reason: '必须豁免：需要 loopback HTTP 上游和真实网关流式转发链路；专项任务：gateway file-streaming integration' },
  { file: 'tests/gateway-path-cookie.test.mjs', reason: '必须豁免：要启动真实 gateway 子进程并连接 loopback HTTP 假上游；专项任务：gateway path/cookie integration' },
  { file: 'tests/gateway-proxy-lifecycle.test.mjs', reason: '必须豁免：要观察真实 gateway 子进程和端口释放时序；专项任务：gateway proxy-lifecycle integration' },
  { file: 'tests/gateway-security.test.mjs', reason: '必须豁免：鉴权/越权断言需要真实 gateway 子进程与本机端口；专项任务：gateway security integration' },
  { file: 'tests/gateway-supervise.test.mjs', reason: '必须豁免：需要 Windows cmd.exe 启动监督脚本、taskkill 按 PID 结束进程并等待时间窗；专项任务：Windows gateway process-supervision' },

  // 真实浏览器与调试端口：DOM 夹具不能验证真实布局、CDP 或 sandbox 行为。
  { file: 'tests/composer_layout.test.mjs', reason: '必须豁免：依赖固定 Edge 可执行文件与真实浏览器视口；专项任务：Edge composer-layout regression' },
  { file: 'tests/feed_entry_layout.test.mjs', reason: '必须豁免：需要本机 Chrome/Edge、CDP 调试端口和本机服务；专项任务：feed browser-layout acceptance' },
  { file: 'tests/feed_full_reader_browser.test.mjs', reason: '必须豁免：需要本机 Chrome/Edge、CDP 调试端口和本机服务；专项任务：feed full-reader browser acceptance' },
  { file: 'tests/layout_diagnostic.test.mjs', reason: '必须豁免：依赖固定 Edge 可执行文件和真实布局测量；专项任务：Edge layout diagnostics' },
  { file: 'tests/user_media_alignment.test.mjs', reason: '必须豁免：依赖本机 Edge、CDP 端口和真实媒体渲染；专项任务：browser media-alignment regression' },

  // PowerShell/JDK/Android 工具链：离线 Node 门禁没有这些专项运行时。
  { file: 'tests/autostart.test.mjs', reason: '必须豁免：需要 PowerShell 执行自启脚本探针；专项任务：Windows autostart integration' },
  { file: 'tests/release_preflight.test.mjs', reason: '必须豁免：需要 PowerShell、假 JDK 与 Android 工具链脚本；专项任务：release/Android preflight' },
  { file: 'tests/devtools_dry_run.test.mjs', reason: '必须豁免：Android devtools 链路需本机 HTTP/WS 服务、UI 探针子进程和假 adb；专项任务：Android devtools dry-run' },
  { file: 'tests/url_guard.test.mjs', reason: '必须豁免：需要本机 JDK 编译并执行 Android 侧 Java 探针；专项任务：Android URL-guard/JDK verification' },

  // 嵌套聚合 runner：再次启动会重复跑全量测试或等待真实超时/进程树清理。
  { file: 'tests/run_all_contract.test.mjs', reason: '必须豁免：会嵌套启动 scripts/run-all-tests.mjs 全量测试；专项任务：test-runner contract validation' },
  { file: 'tests/run_all_timeout.test.mjs', reason: '必须豁免：会嵌套全量 runner 并等待超时、进程树终止；专项任务：test-runner timeout/process-tree validation' },
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
