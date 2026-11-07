package com.hanamobile.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebHistoryItem;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.File;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URLDecoder;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

import javax.net.ssl.SSLException;

import org.json.JSONObject;

/**
 * Hana Mobile —— 最薄的 Android 壳。
 *
 * WebView 直接加载网关地址（同源），所以登录 cookie、WebSocket 全都自然成立。
 *
 * 本类只做七件事：
 *   1. 加载用户选定的接入方式（本机 / USB、Tailscale、公网隧道、自定义，各自记忆一个地址），
 *      地址只能通过原生对话框修改
 *   2. 加载失败时给出可用的「接入方式」入口，而不是一个白屏
 *   3. 返回键先问网页：聊天 → 列表；网页退不动了再退历史；历史也没了就看页面标记
 *      （<meta name="hana-shell">）——是自己的页面就退出，不是（或还没查出来）就给用户
 *      一个可取消的出口，而不是直接退出、也不是直接换页
 *   4. 外部链接交给系统浏览器
 *   5. 接管 <input type="file">：拍照走相机 App，选图走系统文件选择器
 *   6. 每种接入方式可以点「测试」做一次可达性探测（连接与读取各 4 秒，不随请求发送任何凭据）
 *   7. 一轮回复跑完时弹一条本地通知（应用在前台时不弹）；页面通过 WebMessage 通道
 *      叫它做事——这条通道只认 notify / requestPermission 两种动作，不是通用 RPC
 *
 * 一条硬规矩：**不向网页注入任何 Java 对象**。addJavascriptInterface 对所有 frame 生效
 * （包括 show_card 渲染出的卡片 iframe），等于把「持久篡改开始地址」这种能力交给任意
 * 一张卡片。改地址只在原生对话框里发生，网页侧既碰不到也改不了。
 *
 * 页面确实需要原生做事时（发通知），走 WebMessageChannel：原生 createWebMessageChannel()
 * 建一对端口，postWebMessage() 把页面那一端**只投给主 frame**，且只投给 origin 相符的
 * 文档——卡片 iframe 既拿不到端口，也冒充不了来源。见本文后面的「JS → 原生通道」一节。
 *
 * 另外两件只给排错用的事：debuggable 构建里打开 WebView 调试端口（chrome://inspect / CDP，
 * 见 scripts/devtools/），以及把所有构建的页面 console 转发到 logcat 的 HanaWebConsole。
 */
public class MainActivity extends Activity {

    private static final String TAG = "HanaMobile";
    /** 页面 console 的 tag：和壳自己的日志分开，adb logcat -s HanaWebConsole 就只看页面。 */
    private static final String TAG_CONSOLE = "HanaWebConsole";
    /** console 单条日志的截断长度：logcat 单行本来也只留 4KB，再长只会被静默吃掉。 */
    private static final int CONSOLE_MAX_CHARS = 2000;
    private static final String PREFS = "hana_mobile";
    /** 旧版只有一个全局地址键；只在迁移时读，搬完就删，之后地址只认下面四个键。 */
    private static final String KEY_URL_LEGACY = "start_url";
    /** 上次使用的接入方式，下次启动用它。 */
    private static final String KEY_LAST_MODE = "last_mode";
    private static final String KEY_URL_LOCAL = "url_local_usb";
    private static final String KEY_URL_TAILSCALE = "url_tailscale";
    private static final String KEY_URL_TUNNEL = "url_tunnel";
    private static final String KEY_URL_CUSTOM = "url_custom";

    /** 四种接入方式；数组顺序就是对话框里的顺序。 */
    private static final String MODE_LOCAL = "local_usb";
    private static final String MODE_TAILSCALE = "tailscale";
    private static final String MODE_TUNNEL = "tunnel";
    private static final String MODE_CUSTOM = "custom";
    private static final String[] MODES = {MODE_LOCAL, MODE_TAILSCALE, MODE_TUNNEL, MODE_CUSTOM};
    /** 本机 / USB 回家走 adb reverse，地址固定是回环。 */
    private static final String LOCAL_URL = "http://127.0.0.1:24000/";
    /** 自定义方式的初始值（与旧版保持一致）；全新安装走「本机 / USB」，不用它。 */
    private static final String DEFAULT_URL = "http://192.168.1.10:24000/";
    private static final String[] MODE_LABELS = {"本机 / USB", "Tailscale", "公网隧道", "自定义"};
    private static final String[] MODE_PLACEHOLDERS = {
            LOCAL_URL, "http://100.x.x.x:24000/", "https://", "http://主机:端口/"};
    private static final String[] MODE_HINTS = {
            "手机用 USB 连着电脑，先在电脑上执行 adb reverse tcp:24000 tcp:24000",
            "形如 http://100.x.x.x:24000/ 或 http://<机器名>.ts.net:24000/",
            "https:// 或 http:// 的公网地址",
            "http://主机:端口/，和以前一样自由填写"};

    /** 可达性探测只打这一个接口。 */
    private static final String PROBE_PATH = "/api/mobile/bootstrap";
    /** 探测超时：连接与读取各 4 秒。 */
    private static final int PROBE_TIMEOUT_MS = 4000;
    private static final int REQ_FILE_CHOOSER = 0x5101;
    /** 拍照临时文件最多留几个，启动时顺手清旧的。 */
    private static final int KEEP_CAPTURES = 5;
    /** 手输地址的长度上限，超出直接当手滑。 */
    private static final int MAX_URL_LENGTH = 2048;
    /** 错误页上「接入方式」用的自定义协议，只在本 WebView 内拦截，不会发给系统。 */
    private static final String SCHEME_SETUP = "hana-setup";
    /** 网页侧唯一的返回入口；必须同步返回布尔值，evaluateJavascript 才拿得到结果。 */
    private static final String JS_BACK =
            "window.HanaMobile && typeof window.HanaMobile.back === 'function'"
                    + " ? window.HanaMobile.back() : false";
    /** backAction() 的四种结果。 */
    private static final String BACK_NONE = "none";
    private static final String BACK_GO_BACK = "go_back";
    private static final String BACK_FINISH = "finish";
    private static final String BACK_ASK = "ask";
    /**
     * 页面标记：只有 Hana 自己的页面（web/index.html）才带这个 meta。
     *
     * 用标记而不是「同源」判断是不是别人的页面：用户配的地址本来就指着那个域，
     * 运营商插页、隧道断在半路的纯文本照样「同源」，同源判断等于永远放行。
     * 查询脚本用 !! 统一收成布尔，evaluateJavascript 拿到的才是 "true"/"false"
     * 而不是 "null"；执行失败时回调给 null，主叫按「未知」处理。
     */
    private static final String JS_HANA_MARKER =
            "!!document.querySelector('meta[name=\"hana-shell\"]')";

    /* ---------------- 回合完成通知 ---------------- */

    /** 通知通道 ID：建一次就够；重要性一旦被调低就再也调不回来，所以只用默认档。 */
    private static final String CHANNEL_ID_TURNS = "hana_turn_done";
    private static final CharSequence CHANNEL_NAME_TURNS = "任务完成提醒";
    /** 固定通知 ID：一次只留一条「回复完成」，连着跑完两轮也不会堆成一列。 */
    private static final int NOTIFICATION_ID_TURN = 0x48414E41;
    /** 通知标题 / 正文的字符上限：锁屏上只看得见一两行，再长也显示不出来。 */
    private static final int NOTIFICATION_TITLE_MAX = 64;
    private static final int NOTIFICATION_BODY_MAX = 160;
    /** 系统权限请求码；onRequestPermissionsResult 只认这一个。 */
    private static final int REQ_POST_NOTIFICATIONS = 0x6204;
    /** 「已经问过一次」的标记：用户拒了就不再反复弹（在系统设置里批准后仍然按 granted 回答）。 */
    private static final String KEY_NOTIF_PERM_ASKED = "notif_perm_asked";
    private static final String PERM_GRANTED = "granted";
    private static final String PERM_DENIED = "denied";
    private static final String PERM_UNSUPPORTED = "unsupported";

    /* ---------------- JS → 原生通道（WebMessage） ---------------- */

    /** 通道协议版本；不一致的消息直接丢。 */
    private static final int BRIDGE_PROTOCOL_VERSION = 1;
    /** 单条消息的字符上限：通知标题/正文加起来也就几十个字，超长一律当异常。 */
    private static final int BRIDGE_MAX_CHARS = 2048;
    /**
     * 要页面回 hello 的原因：onPageFinished 可能早于页面模块脚本挂上监听，
     * 递一次端口可能落空。按这组间隔重投，总共约 2.4 秒，收到 hello 就停。
     */
    private static final long[] BRIDGE_RETRY_MS = {0L, 400L, 1200L, 2400L};
    /** 递端口时说的那一句话：页面只靠这个指纹认我们的握手（窗口上还有卡片的消息）。 */
    private static final String BRIDGE_HELLO = "{\"v\":1,\"bridge\":\"hana-native\",\"max\":2048}";

    private WebView web;
    private String startUrl;
    /** 当前接入方式，决定启动地址和对话框的初始选中项。 */
    private String currentMode = MODE_LOCAL;
    private SharedPreferences prefs;
    private AlertDialog urlDialog;
    /** 连按「测试」时只认最后一次探测的结果。 */
    private int probeSeq;
    /** 连按返回时只认最后一次询问的结果。 */
    private int backSeq;
    /** 当前停在错误页；这时的返回键直接退出，别在「失败页 ↔ 错误页」之间打转。 */
    private boolean errorPageShown;
    /**
     * 当前页面是不是 Hana 自己的页面：true / false 是查到的结论，null 是「还没查完 / 查不到」。
     *
     * 三态：只有 true 才能不经提醒直接退出；false 和 null 都给可取消的对话框。
     * null 不能当成「别人的页面」直接处理掉——刚导航过去就按返回时它就是 null。
     */
    private Boolean pageIsHana;
    /** 主帧导航序号；onPageFinished 的标记查询结果只对发起它的那次导航有效。 */
    private int pageMarkSeq;
    /** 「这个页面不是 Hana 的页面」对话框；同一时刻只开一层。 */
    private AlertDialog foreignPageDialog;

    private ValueCallback<Uri[]> fileCallback;
    private final FileChooserState fileChooserState = new FileChooserState();
    private ArrayList<String> pendingAcceptTypes;
    private AlertDialog fileChoiceDialog;
    private Uri cameraUri;

    /** 通知通道建过没有（API 26+ 重复建是幂等的，这里只是少一次系统调用）。 */
    private boolean notificationChannelReady;
    /** 前台标志：onResume / onPause 维护。前台且有焦点时不发系统通知。 */
    private boolean activityResumed;
    /** 窗口焦点：onWindowFocusChanged 维护（拉下通知栏 / 弹系统对话框时都算没焦点）。 */
    private boolean windowFocused;
    /** 原生这一端的消息端口；null 表示页面还没接过（或已失效）。 */
    private WebMessagePort bridgePort;
    /** 页面回了 hello：握手完成，剩下的重投全部停掉。 */
    private boolean bridgeAcked;
    /** 握手的轮次：页面换了 / 已握手成功，旧的定时重投自动作废。 */
    private int bridgeRound;
    /** 在等结果的权限请求：回给哪个端口、用哪个请求 id。 */
    private WebMessagePort permissionPort;
    private String permissionRequestId;
    /** 重投端口用的定时器；Activity 销毁时清掉。 */
    private Handler bridgeHandler;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        migrateLegacyStartUrl(prefs);
        currentMode = normalizeMode(prefs.getString(KEY_LAST_MODE, null));
        // 存量值可能被旧版本写坏，统一过一遍校验；不合格就当没配，走对话框
        startUrl = normalizeStartUrl(rememberedUrlFor(currentMode));

        // 通知通道先建好（幂等）：之后任何一条通知都直接往里丢。
        ensureNotificationChannel();
        // 递消息端口要延迟重投，这里要一个主线程定时器。
        bridgeHandler = new Handler(Looper.getMainLooper());

        // 调试端口要在建 WebView 之前决定：端口一开，同机（USB 调试）的人就能在页面里执行任意脚本
        enableWebContentsDebugging();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F7F1E7"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                // setup 协议：错误页主帧，或同源页面里的用户手势。
                // 后者是为了正常连线时也能从侧边栏切接入方式；跨源页无论如何不给开。
                if (SCHEME_SETUP.equals(scheme)) {
                    boolean trusted = request.isForMainFrame()
                            && (errorPageShown || (request.hasGesture() && sameOrigin(view.getUrl(), startUrl)));
                    if (trusted) promptForStartUrl(null, null);
                    return true;
                }
                if (sameOrigin(uri.toString(), startUrl)) return false;
                // 跨源子帧不能导航，也不能借壳打开系统应用。
                if (!request.isForMainFrame()) return true;
                // 顶层外链仅允许用户手势发起的安全 HTTP(S) URL。
                if (!request.hasGesture() || !isSafeHttpUrl(uri.toString())) return true;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    Log.w(TAG, "cannot open externally: " + uri.getScheme() + "://" + uri.getHost(), e);
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // 主帧开始加载（此回调只报主帧）：旧结论立即作废，查完之前一律是「未知」
                pageMarkSeq += 1;
                pageIsHana = null;
                // 文档要换了，原生这一端的端口跟着作废，旧的重投也别再跑。
                resetNativeBridge();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                final int seq = pageMarkSeq;
                try {
                    view.evaluateJavascript(JS_HANA_MARKER, (value) -> {
                        if (seq != pageMarkSeq) return;   // 期间又导航过了，这次结果作废
                        if ("true".equals(value)) {
                            pageIsHana = Boolean.TRUE;
                        } else if ("false".equals(value)) {
                            pageIsHana = Boolean.FALSE;
                        }                                     // 其余（null / 执行失败）保持未知
                    });
                } catch (Exception e) {
                    Log.w(TAG, "page marker probe failed");
                }
                // 页面（主 frame）加载完了：递一个原生消息端口，页面侧等它最多 3 秒。
                beginBridgeHandshake();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                String url = startUrl == null ? "" : startUrl;
                Log.w(TAG, "main frame failed: " + redactUrlForLog(url));
                // 连不上正是要改地址的时候：错误页带入口，同时把对话框弹出来
                showErrorPage(url);
                promptForStartUrl(url.isEmpty() ? null : "连不上 " + url, url.isEmpty() ? null : url);
            }
        });

        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                handleDownloadStart(url, userAgent, contentDisposition, mimeType));

        // WebView 的回调不提供发起 file input 的 frame；只校验当前顶层来源并让用户确认。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // 纯日志，不暴露任何端口，所以 release 构建也开着：出事时至少有一条线可查。
                if (message == null) return false;
                Log.println(consoleLogPriority(message.messageLevel()), TAG_CONSOLE, formatConsoleMessage(message));
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (callback == null) return true;
                // A 的 picker 或确认仍在等待时，B 只能被拒绝，绝不能替换 A 的 callback/state。
                if (fileCallback != null || fileChooserState.isBusy()) {
                    callback.onReceiveValue(null);
                    return true;
                }
                if (errorPageShown || !sameOrigin(view.getUrl(), startUrl)) {
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "仅允许从当前同源页面选择文件", Toast.LENGTH_LONG).show();
                    return true;
                }

                String[] rawAcceptTypes = params == null ? null : params.getAcceptTypes();
                ArrayList<String> acceptedTypes = resolveAcceptTypes(rawAcceptTypes);
                if (acceptedTypes == null) {
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "页面请求的文件类型无效", Toast.LENGTH_LONG).show();
                    return true;
                }
                if (!fileChooserState.begin(startUrl)) {
                    callback.onReceiveValue(null);
                    return true;
                }

                cameraUri = null;
                fileCallback = callback;
                pendingAcceptTypes = new ArrayList<>(acceptedTypes);
                showFileChooserConfirmation(params, acceptedTypes);
                return true;
            }
        });

        setContentView(web);
        installBackDispatcher();

        if (startUrl == null) {
            // 没配过 / 配坏了：先给一张能改地址的错误页，再把对话框弹出来；取消也不会白屏
            showErrorPage(null);
            promptForStartUrl(null, null);
        } else {
            web.loadUrl(startUrl);
        }

        Log.i(TAG, "started with " + redactUrlForLog(startUrl));
    }

    /* ------------------------------------------------------------------ */
    /* 排错：调试端口与页面 console                                        */
    /* ------------------------------------------------------------------ */

    /**
     * 只在 debuggable 构建里打开 WebView 调试端口（chrome://inspect、CDP）。
     *
     * 判断依据是系统实际安装的这个包的 FLAG_DEBUGGABLE，不看版本号也不看 BuildConfig：
     * release 包里这段代码仍然在，但分支永远不会进，端口不会监听。端口一开，能碰到
     * 这台机器（USB 调试 / 同机 adb）的人就可以在页面里执行任意脚本。
     *
     * 构建侧对应 android/build.ps1 的 -Debuggable（默认不开）。
     */
    private void enableWebContentsDebugging() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) {
            Log.i(TAG, "WebView 调试端口未开启（release 构建）");
            return;
        }
        try {
            WebView.setWebContentsDebuggingEnabled(true);
            Log.i(TAG, "WebView 调试端口已开启（debuggable 构建）");
        } catch (Throwable t) {
            // 极端机型上 WebView 提供者不认这个开关；不能因此起不了壳
            Log.w(TAG, "WebView 调试端口开启失败", t);
        }
    }

    /**
     * 一条 console 日志 = 一行：[level] message @file:line。
     *
     * 会在 release 包里也打到 logcat，所以这里只放行页面自己的内容：sourceId 里的 ?query 与
     * #fragment 整段切掉（用户完全可能把 token 放在那里），换行折成 ⏎ 保持单行，超长截断。
     */
    static String formatConsoleMessage(ConsoleMessage message) {
        String level = consoleLevelName(message.messageLevel());
        String text = message.message() == null ? "" : message.message();
        text = text.replace("\r\n", "\n").replace('\r', '\n').replace("\n", " ⏎ ");
        if (text.length() > CONSOLE_MAX_CHARS) {
            text = text.substring(0, CONSOLE_MAX_CHARS) + "…(截断，全文 " + text.length() + " 字)";
        }

        String source = message.sourceId() == null ? "" : message.sourceId();
        int cut = source.indexOf('?');
        if (cut >= 0) source = source.substring(0, cut);
        cut = source.indexOf('#');
        if (cut >= 0) source = source.substring(0, cut);
        if (source.isEmpty()) source = "(unknown)";

        return "[" + level + "] " + text + " @" + source + ":" + message.lineNumber();
    }

    /** console 级别转成日志里的小写名字；未知级别当 log。 */
    private static String consoleLevelName(ConsoleMessage.MessageLevel level) {
        if (level == null) return "log";
        switch (level) {
            case TIP: return "tip";
            case LOG: return "log";
            case WARNING: return "warn";
            case ERROR: return "error";
            case DEBUG: return "debug";
            default: return "log";
        }
    }

    /** 让 `adb logcat *:W` 这类过滤也留得住页面报错，而不是全落到 INFO。 */
    private static int consoleLogPriority(ConsoleMessage.MessageLevel level) {
        if (level == null) return Log.INFO;
        switch (level) {
            case ERROR: return Log.ERROR;
            case WARNING: return Log.WARN;
            case DEBUG: return Log.DEBUG;
            default: return Log.INFO;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 接入方式：只有原生对话框能改开始地址                                 */
    /* ------------------------------------------------------------------ */

    /**
     * 连不上时给一张纸色错误页，带「接入方式」按钮。
     *
     * 页面里只有静态 HTML，没有脚本；按钮只是导航到自定义协议，由
     * shouldOverrideUrlLoading 拦下来弹原生对话框。这样「改地址」这条路上
     * 没有任何网页代码够得到的原生接口。
     */
    private void showErrorPage(String url) {
        String shown = (url == null || url.isEmpty()) ? "还没选好接入方式" : url;
        renderSetupPage("连不上", shown);
    }

    /**
     * 停在别人的页面上时给用户三个出口：改接入方式 / 退出 / 取消。
     *
     * 这种页面（隧道断在半路返回的纯文本、运营商插页之类）里没有侧边栏，也没有我们的
     * 任何入口；直接退出就再也改不了地址，直接替换页面又剥夺了用户「先看一眼」的选择。
     * 所以只弹对话框：不换页、不退出，点外面或按返回都等于取消。
     */
    private void promptForForeignPage() {
        if (isFinishing() || isDestroyed()) return;
        if (foreignPageDialog != null && foreignPageDialog.isShowing()) return;   // 不叠第二层
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("这个页面不是 Hana 的页面")
                .setMessage("可能是网络被插了东西，或者隧道断在半路。可以换一种接入方式再连，也可以直接退出。")
                .setCancelable(true)
                .setPositiveButton("改接入方式", (d, which) -> promptForStartUrl(null, null))
                .setNeutralButton("退出", (d, which) -> finish())
                .setNegativeButton("取消", null)
                .create();
        dialog.setOnDismissListener((d) -> {
            if (foreignPageDialog == dialog) foreignPageDialog = null;
        });
        foreignPageDialog = dialog;
        dialog.show();
    }

    private void renderSetupPage(String heading, String detail) {
        if (web == null) return;
        errorPageShown = true;
        String html = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                + "<style>"
                + "html,body{margin:0;height:100%;background:#F7F1E7;color:#2F2A24;"
                + "font-family:-apple-system,'PingFang SC','Microsoft YaHei',system-ui,sans-serif}"
                + "body{padding:calc(env(safe-area-inset-top) + 88px) 24px 24px;box-sizing:border-box}"
                + "h1{font-size:22px;margin:0 0 10px}"
                + ".url{margin:0 0 26px;color:#8A7F70;font-size:13px;line-height:1.7;word-break:break-all}"
                + ".btn{display:block;padding:15px;border-radius:12px;background:#2F6FB3;color:#fff;"
                + "font-size:16px;font-weight:600;text-align:center;text-decoration:none}"
                + ".hint{margin-top:26px;color:#8A7F70;font-size:12.5px;line-height:1.85}"
                + "</style></head><body>"
                + "<h1>" + escapeHtml(heading) + "</h1>"
                + "<p class=\"url\">" + escapeHtml(detail) + "</p>"
                + "<a class=\"btn\" href=\"" + SCHEME_SETUP + "://edit-url\">接入方式</a>"
                + "<p class=\"hint\">网关要跑在那台电脑上。USB 连着电脑用「本机 / USB」，"
                + "不在同一网络用 Tailscale 的 100.x 地址，出差在外用公网隧道。</p>"
                + "</body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    /**
     * 原生「接入方式」对话框：整个 App 里唯一能改开始地址的地方。
     *
     * 四种方式（本机 / USB、Tailscale、公网隧道、自定义）各记一个地址，切回某种方式时
     * 显示它上次的地址；每行右侧的「测试」只对 /api/mobile/bootstrap 发一次裸 GET，
     * 把「通不通、多少毫秒」告诉用户。仍然用 AlertDialog，与壳里其他对话框长得一样。
     *
     * @param reason    为什么弹（连不上某地址时带上），可为 null
     * @param attempted 上次失败 / 输入的内容，再打开时留在输入框里，可为 null
     */
    private void promptForStartUrl(String reason, String attempted) {
        if (web == null) return;
        if (urlDialog != null && urlDialog.isShowing()) return;   // 不叠第二层

        final float density = getResources().getDisplayMetrics().density;
        final int pad = Math.round(density * 20);

        final StartUrlDialog state = new StartUrlDialog();
        final LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(pad, Math.round(pad / 2f), pad, 0);

        for (int i = 0; i < MODES.length; i += 1) {
            final int index = i;

            final RadioButton radio = new RadioButton(this);
            radio.setText(MODE_LABELS[i]);
            radio.setSingleLine(true);
            state.radios[i] = radio;

            final Button test = new Button(this);
            test.setText("测试");
            test.setAllCaps(false);
            test.setMinimumWidth(0);
            test.setPadding(Math.round(density * 10), 0, Math.round(density * 10), 0);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.addView(radio, new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(test, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            content.addView(row);

            radio.setOnClickListener(v -> state.select(MODES[index]));
            test.setOnClickListener(v -> state.probe(index));
        }

        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = Math.round(density * 10);
        content.addView(state.input, inputParams);
        content.addView(state.hint);
        content.addView(state.status);

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle("接入方式")
                .setView(content)
                .setCancelable(true)                     // 返回键 / 点外面也能取消
                .setPositiveButton("连接", null)          // 真正的点击在 setOnShowListener 里接管
                .setNegativeButton("取消", null);
        if (reason != null && !reason.isEmpty()) builder.setMessage(reason);

        final AlertDialog dialog = builder.create();
        state.dialog = dialog;
        state.prepare(attempted);
        dialog.setOnShowListener((d) -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener((v) -> {
            String mode = state.selected[0];
            String normalized = normalizeStartUrl(state.input.getText().toString());
            if (normalized == null) {
                Toast.makeText(this, "地址要写成 主机:端口 或 http://主机:端口/", Toast.LENGTH_LONG).show();
                return;                              // 不关对话框，接着改就是了
            }
            dialog.dismiss();
            rememberMode(mode, normalized);
            startWithUrl(normalized);
        }));
        dialog.setOnDismissListener((d) -> {
            probeSeq += 1;                           // 关掉之后才到的探测结果一律作废
            if (urlDialog == dialog) urlDialog = null;
        });
        urlDialog = dialog;
        dialog.show();
    }

    /**
     * 「接入方式」对话框的视图与状态。
     *
     * 单独拎成一个内部类，是因为它同时要管四个单选、四份草稿和一个异步探测结果；
     * 全塞进 promptForStartUrl 的话，lambda 之间得穿一堆平行数组。
     */
    private final class StartUrlDialog {
        final EditText input = new EditText(MainActivity.this);
        final TextView hint = new TextView(MainActivity.this);
        final TextView status = new TextView(MainActivity.this);
        final RadioButton[] radios = new RadioButton[MODES.length];
        /** 每种方式在本次对话框里的草稿，初值是该方式上次记住的地址。 */
        final String[] draft = new String[MODES.length];
        final String[] selected = {currentMode};
        AlertDialog dialog;

        StartUrlDialog() {
            float density = getResources().getDisplayMetrics().density;

            input.setSingleLine(true);
            input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);

            hint.setTextSize(12.5f);
            hint.setTextColor(Color.parseColor("#8A7F70"));
            hint.setPadding(0, Math.round(density * 6), 0, 0);

            status.setTextSize(13f);
            status.setTextColor(Color.parseColor("#8A7F70"));
            status.setPadding(0, Math.round(density * 10), 0, 0);
            status.setVisibility(View.GONE);

            for (int i = 0; i < MODES.length; i += 1) {
                draft[i] = rememberedUrlFor(MODES[i]);
            }
        }

        /** 首次铺屏：把上次失败的地址放回当前方式，再按当前方式刷新一遍。 */
        void prepare(String attempted) {
            if (attempted != null && !attempted.isEmpty()) {
                draft[modeIndex(selected[0])] = attempted;
            }
            render();
        }

        /** 点中某一行：先把当前输入存进旧方式的草稿，再显示新方式上次的地址。 */
        void select(String mode) {
            draft[modeIndex(selected[0])] = input.getText().toString();
            selected[0] = mode;
            render();
        }

        /** 按当前选中的方式铺一遍输入框、提示与状态行；没有 RadioGroup，手动保证只选一个。 */
        private void render() {
            int index = modeIndex(selected[0]);
            for (int i = 0; i < MODES.length; i += 1) {
                radios[i].setChecked(i == index);
            }
            input.setText(draft[index]);
            input.setSelection(input.getText().length());
            input.setHint(MODE_PLACEHOLDERS[index]);
            hint.setText(MODE_HINTS[index]);
            hint.setVisibility(MODE_HINTS[index].isEmpty() ? View.GONE : View.VISIBLE);
            status.setVisibility(View.GONE);
        }

        /** 某一行右侧的「测试」：选中的那行测输入框里的内容，其他行测它记着的地址。 */
        void probe(int index) {
            String address = index == modeIndex(selected[0]) ? input.getText().toString() : draft[index];
            final int seq = ++probeSeq;
            final String label = MODE_LABELS[index];
            status.setVisibility(View.VISIBLE);
            status.setTextColor(Color.parseColor("#8A7F70"));
            status.setText(label + "：正在测试…");
            probeBootstrap(address, (reachable, detail) -> {
                if (seq != probeSeq) return;               // 只有最后一次探测算数
                if (dialog == null || !dialog.isShowing()) return;
                status.setVisibility(View.VISIBLE);
                status.setTextColor(Color.parseColor(reachable ? "#2F6FB3" : "#B4462F"));
                status.setText(label + "：" + detail);
            });
        }
    }

    /** 探测结果回调；只在主线程调用。 */
    private interface ProbeCallback {
        void onProbe(boolean reachable, String detail);
    }

    /**
     * 对 <base>/api/mobile/bootstrap 发一次裸 GET，回答「这张地址通不通」。
     *
     * 不发 Cookie、不发 Authorization、不跟随重定向，连接与读取各 4 秒（所以超时可能超过 4 秒）；
     * 日志里只有 origin 与固定的探测路径，不出现查询串、响应或凭据。
     */
    private void probeBootstrap(String address, ProbeCallback callback) {
        final String probeUrl = bootstrapProbeUrl(normalizeStartUrl(address));
        if (probeUrl == null) {
            callback.onProbe(false, "先填一个 http:// 或 https:// 地址");
            return;
        }
        Log.i(TAG, "probe " + probeUrl);
        Thread worker = new Thread(() -> {
            boolean reachable;
            String detail;
            long startedAt = SystemClock.elapsedRealtime();
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) URI.create(probeUrl).toURL().openConnection();
                connection.setRequestMethod("GET");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(PROBE_TIMEOUT_MS);
                connection.setReadTimeout(PROBE_TIMEOUT_MS);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/json");
                int code = connection.getResponseCode();
                long cost = SystemClock.elapsedRealtime() - startedAt;
                if (code >= 200 && code <= 299) {
                    reachable = true;
                    detail = "可达 " + cost + " ms";
                } else if (code == 401 || code == 403) {
                    // 401/403 也可能来自 WAF、反代、错误的路由，不能一口咬定「需要登录」
                    reachable = true;
                    detail = "服务端返回 HTTP " + code + "（未带登录）";
                } else if (code >= 300 && code <= 399) {
                    reachable = false;
                    detail = "被重定向（HTTP " + code + "）";
                } else {
                    reachable = false;
                    detail = "HTTP " + code;
                }
            } catch (SocketTimeoutException e) {
                reachable = false;
                // 连接与读取各 4 秒，所以「超时」不等于 4 秒整：文案不能写死成 4 秒
                detail = "超时（连接或读取超过 4 秒）";
            } catch (ConnectException e) {
                reachable = false;
                detail = "连接被拒";
            } catch (UnknownHostException e) {
                reachable = false;
                detail = "解析不到域名";
            } catch (SSLException e) {
                reachable = false;
                detail = "证书或 TLS 失败";
            } catch (Exception e) {
                reachable = false;
                detail = "连不上";
            } finally {
                if (connection != null) connection.disconnect();
            }
            final boolean ok = reachable;
            final String text = detail;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                callback.onProbe(ok, text);
            });
        }, "hana-probe");
        worker.setDaemon(true);
        worker.start();
    }

    /**
     * 把用户填的地址收成 origin + /api/mobile/bootstrap；地址不合法返回 null。
     *
     * 只取 scheme 与 authority：用户可能填了带路径或查询串的地址（比如 https://host/app/），
     * 探测仍该打到网关根上的那个接口。
     */
    static String bootstrapProbeUrl(String normalizedBase) {
        if (normalizedBase == null) return null;
        try {
            URI uri = new URI(normalizedBase);
            String scheme = uri.getScheme();
            String authority = uri.getRawAuthority();
            if (scheme == null || authority == null || authority.isEmpty()) return null;
            if (uri.getRawUserInfo() != null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            return scheme + "://" + authority + PROBE_PATH;
        } catch (Exception e) {
            return null;
        }
    }

    /** 记住这次选的接入方式和地址，下次启动用它。 */
    private void rememberMode(String mode, String normalized) {
        currentMode = mode;
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        editor.putString(keyForMode(mode), normalized);
        editor.putString(KEY_LAST_MODE, mode);
        editor.apply();
    }

    /**
     * 旧版本只有一个全局地址；搬进「自定义」并记住模式，搬完就把旧键删掉。
     *
     * 只在旧键还在时跑一次；没这个键的用户（含全新安装）不走这里，按 normalizeMode 的规则取默认值。
     */
    private void migrateLegacyStartUrl(SharedPreferences prefs) {
        if (!prefs.contains(KEY_URL_LEGACY)) return;
        String legacy = normalizeStartUrl(prefs.getString(KEY_URL_LEGACY, null));
        SharedPreferences.Editor editor = prefs.edit();
        if (legacy != null && !prefs.contains(keyForMode(MODE_CUSTOM))) {
            editor.putString(keyForMode(MODE_CUSTOM), legacy);
        }
        if (!prefs.contains(KEY_LAST_MODE)) {
            editor.putString(KEY_LAST_MODE, MODE_CUSTOM);
        }
        editor.remove(KEY_URL_LEGACY);
        editor.apply();
    }

    /** 该方式记住的地址；没存过或存坏了就回退到它的默认值。 */
    private String rememberedUrlFor(String mode) {
        String stored = prefs == null ? null : prefs.getString(keyForMode(mode), null);
        String normalized = normalizeStartUrl(stored);
        return normalized != null ? normalized : defaultUrlFor(mode);
    }

    /** 每种方式的默认值；空串表示「等用户自己填」。 */
    private static String defaultUrlFor(String mode) {
        if (MODE_LOCAL.equals(mode)) return LOCAL_URL;
        if (MODE_CUSTOM.equals(mode)) return DEFAULT_URL;
        return "";
    }

    private static String keyForMode(String mode) {
        if (MODE_LOCAL.equals(mode)) return KEY_URL_LOCAL;
        if (MODE_TAILSCALE.equals(mode)) return KEY_URL_TAILSCALE;
        if (MODE_TUNNEL.equals(mode)) return KEY_URL_TUNNEL;
        return KEY_URL_CUSTOM;
    }

    /** 存坏 / 旧值不认识时按「本机 / USB」处理：它是唯一不用提前配网络的方式。 */
    private static String normalizeMode(String raw) {
        for (String mode : MODES) {
            if (mode.equals(raw)) return mode;
        }
        // 全新安装（或存坏了）先试「本机 / USB」：它是唯一不需要提前配网络的方式，
        // 连不上时错误页的「接入方式」会把三条预设都摆出来。
        return MODE_LOCAL;
    }

    private static int modeIndex(String mode) {
        for (int i = 0; i < MODES.length; i += 1) {
            if (MODES[i].equals(mode)) return i;
        }
        return MODES.length - 1;
    }

    /** 加载刚确认的地址。 */
    private void startWithUrl(String normalized) {
        startUrl = normalized;
        errorPageShown = false;
        Log.i(TAG, "start url -> " + redactUrlForLog(normalized));
        if (web != null) web.loadUrl(normalized);
    }

    /**
     * 把用户输入规整成能加载的 http(s) URL；不合格返回 null。
     *
     * 刻意只用 JDK 类型（java.net.URI），不碰 android.*：这样这段校验能被
     * tests/url_guard.test.mjs 原文抽出来在裸 JVM 上编译执行——测的就是真正进包的那段代码。
     * 方法体里也别写带大括号的字符串字面量：测试靠大括号配对来切方法。
     */
    static String normalizeStartUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty() || s.length() > MAX_URL_LENGTH) return null;
        for (int i = 0; i < s.length(); i += 1) {
            char c = s.charAt(i);
            if (c <= ' ' || c == 0x7f) return null;          // 空白与控制字符一律不收
        }

        boolean hasScheme = s.matches("[A-Za-z][A-Za-z0-9+.\\-]*://.*");
        boolean bareHostPort = s.matches("[A-Za-z][A-Za-z0-9+.\\-]*:[0-9]+(/.*)?");
        if (hasScheme) {
            String declared = s.substring(0, s.indexOf("://")).toLowerCase(Locale.ROOT);
            if (!"http".equals(declared) && !"https".equals(declared)) return null;
            s = declared + s.substring(s.indexOf("://"));     // 协议名统一小写
        } else if (bareHostPort) {
            s = "http://" + s;                               // localhost:24000
        } else if (s.matches("[A-Za-z][A-Za-z0-9+.\\-]*:.*")) {
            return null;                                     // javascript: / file: / intent: / data:
        } else {
            s = "http://" + s;                               // 192.168.x.x:24000、example.com
        }

        URI uri;
        try {
            uri = new URI(s);
        } catch (Exception e) {
            return null;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || host.isEmpty()) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        if (uri.getUserInfo() != null) return null;          // http://user:pw@host 这种写法不收
        // :0 不是「默认端口」。只拒绝 > 65535 会让 http://host:0/ 存进配置，而 isSafeHttpUrl
        // 又拒绝它，于是同源判断、文件选择、下载校验全判无效。归一化阶段就拦住。
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) return null;
        String authority = uri.getRawAuthority();
        if (authority == null || authority.isEmpty()) return null;

        StringBuilder out = new StringBuilder(s.length() + 1);
        out.append(scheme).append("://").append(authority);
        String path = uri.getRawPath();
        if (path == null || path.isEmpty()) {
            out.append('/');                                 // 只有主机时补根路径
        } else {
            out.append(path);
        }
        if (uri.getRawQuery() != null) out.append('?').append(uri.getRawQuery());
        if (uri.getRawFragment() != null) out.append('#').append(uri.getRawFragment());
        return out.toString();
    }

    /**
     * 日志用的地址：只留 scheme://host[:port] 和一个路径标志。
     *
     * 完整地址会进 logcat，而用户完全可能把 token 放在 query 或 fragment 里
     * （例如 https://host:24000/#token=xxx）。所以路径内容、查询串、fragment 都不出现，
     * 只保留「是不是根路径」这一个信息量，方便对着日志判断地址填歪了没有。
     */
    static String redactUrlForLog(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "(unset)";
        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty()) return "(unparsable)";
            // URI.getHost() 对 IPv6 字面量已经带方括号（[::1]），不能再包一层
            String authority = host.startsWith("[") || host.indexOf(':') < 0 ? host : "[" + host + "]";
            int port = uri.getPort();
            if (port != -1) authority = authority + ":" + port;
            String path = uri.getRawPath();
            boolean root = path == null || path.isEmpty() || "/".equals(path);
            return scheme.toLowerCase(Locale.ROOT) + "://" + authority
                    + " path=" + (root ? "/" : "set");
        } catch (Exception e) {
            return "(unparsable)";
        }
    }

    /** 仅接受结构有效、无 userinfo 的 HTTP(S) URL。 */
    static boolean isSafeHttpUrl(String raw) {
        if (raw == null || raw.isEmpty()) return false;
        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty() || uri.getRawAuthority() == null) return false;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            if (uri.getRawUserInfo() != null) return false;
            int port = uri.getPort();
            return port == -1 || (port >= 1 && port <= 65535);
        } catch (Exception e) {
            return false;
        }
    }

    /** 严格比较 HTTP(S) scheme、host 与 effective port。 */
    static boolean sameOrigin(String candidate, String configuredUrl) {
        if (!isSafeHttpUrl(candidate) || !isSafeHttpUrl(configuredUrl)) return false;
        try {
            URI target = new URI(candidate);
            URI configured = new URI(configuredUrl);
            String targetScheme = target.getScheme().toLowerCase(Locale.ROOT);
            String configuredScheme = configured.getScheme().toLowerCase(Locale.ROOT);
            if (!targetScheme.equals(configuredScheme)
                    || !target.getHost().equalsIgnoreCase(configured.getHost())) return false;
            int targetPort = target.getPort() == -1
                    ? ("https".equals(targetScheme) ? 443 : 80) : target.getPort();
            int configuredPort = configured.getPort() == -1
                    ? ("https".equals(configuredScheme) ? 443 : 80) : configured.getPort();
            return targetPort == configuredPort;
        } catch (Exception e) {
            return false;
        }
    }

    /** 下载只允许同源、无 fragment、路径完全匹配的 workspace content 接口。 */
    static boolean isWorkspaceContentUrl(String candidate, String configuredUrl) {
        if (!sameOrigin(candidate, configuredUrl)) return false;
        try {
            URI uri = new URI(candidate);
            return uri.getRawUserInfo() == null
                    && uri.getRawFragment() == null
                    && "/api/mobile/workspace/content".equals(uri.getRawPath());
        } catch (Exception e) {
            return false;
        }
    }

    /** 只保留安全 basename；拒绝控制字符、路径片段与超长输入。 */
    static String sanitizeDownloadFileName(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 4096) return null;
        String pathless = raw.replace('\\', '/');
        int slash = pathless.lastIndexOf('/');
        String basename = slash >= 0 ? pathless.substring(slash + 1) : pathless;
        StringBuilder filtered = new StringBuilder(basename.length());
        for (int i = 0; i < basename.length(); i += 1) {
            char c = basename.charAt(i);
            if (!Character.isISOControl(c)) filtered.append(c);
        }
        String name = filtered.toString().trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) return null;

        byte[] bytes = name.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        if (bytes.length > 180) {
            int dot = name.lastIndexOf('.');
            String extension = dot > 0 ? name.substring(dot) : "";
            int extensionBytes = extension.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            if (extensionBytes > 48) {
                extension = "";
                extensionBytes = 0;
            }
            int budget = 180 - extensionBytes;
            String stem = dot > 0 ? name.substring(0, dot) : name;
            StringBuilder shortened = new StringBuilder();
            int used = 0;
            for (int i = 0; i < stem.length();) {
                int codePoint = stem.codePointAt(i);
                String part = new String(Character.toChars(codePoint));
                int partBytes = part.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                if (used + partBytes > budget) break;
                shortened.append(part);
                used += partBytes;
                i += Character.charCount(codePoint);
            }
            name = shortened.append(extension).toString();
        }
        return name.isEmpty() ? null : name;
    }

    /**
     * 决定落盘文件名：默认用原名，只在下载目录里已存在同名文件时才加序号。
     *
     * 以前一律拼 UUID，结果变成「文献总结_20261101-a1da05c9-….docx」这种没法分享的名字。
     * 现在只看名字被没被占：没占就用原名，被占就 -2、-3 往后排，99 个都占才退回短随机。
     * dir 为空（拿不到下载目录）时直接给原名，宁可让 DownloadManager 自己处理重名。
     */
    static String uniqueDownloadFileName(String raw, File dir) {
        String name = sanitizeDownloadFileName(raw);
        if (name == null) return null;
        if (dir == null || !new File(dir, name).exists()) return name;
        int dot = name.lastIndexOf('.');
        int split = dot > 0 ? dot : name.length();
        String base = name.substring(0, split);
        String ext = name.substring(split);
        for (int i = 2; i <= 99; i++) {
            String candidate = base + "-" + i + ext;
            if (!new File(dir, candidate).exists()) return candidate;
        }
        return base + "-" + UUID.randomUUID().toString().substring(0, 8) + ext;
    }

    /** MIME 与 accept 精确匹配；支持通配类型，拒绝未知类型。 */
    static boolean matchesAcceptedMimeType(String actualMimeType, String acceptedType) {
        if (actualMimeType == null || acceptedType == null) return false;
        String actual = actualMimeType.trim().toLowerCase(Locale.ROOT);
        String accepted = acceptedType.trim().toLowerCase(Locale.ROOT);
        int parameter = actual.indexOf(';');
        if (parameter >= 0) actual = actual.substring(0, parameter).trim();
        int slash = actual.indexOf('/');
        if (slash <= 0 || slash == actual.length() - 1 || actual.indexOf('/', slash + 1) >= 0
                || actual.indexOf('*') >= 0) return false;
        if ("*/*".equals(accepted)) return true;
        if (accepted.endsWith("/*")) {
            int acceptedSlash = accepted.indexOf('/');
            return acceptedSlash > 0 && acceptedSlash == accepted.length() - 2
                    && actual.substring(0, slash).equals(accepted.substring(0, acceptedSlash));
        }
        return actual.equals(accepted);
    }

    /** 未知 MIME 只在用户明确选择任意类型时放行；MIME 不承担 URI 权限判断。 */
    static boolean acceptsFileMimeType(String actualMimeType, ArrayList<String> acceptedTypes) {
        if (acceptedTypes == null) return false;
        if (acceptedTypes.isEmpty()) return true;
        if (actualMimeType == null || actualMimeType.trim().isEmpty()) return acceptedTypes.contains("*/*");
        for (String acceptedType : acceptedTypes) {
            if (matchesAcceptedMimeType(actualMimeType, acceptedType)) return true;
        }
        return false;
    }

    /** 文件选择结果只接受带 authority 的 content URI。 */
    static boolean isAllowedContentUri(String scheme, String authority) {
        return "content".equalsIgnoreCase(scheme) && authority != null && !authority.trim().isEmpty();
    }

    /** 单个确认/选择事务；originSnapshot 保存配置 URL，所有检查都只比较其严格 origin。 */
    static final class FileChooserState {
        private String originSnapshot;
        private boolean pickerInFlight;

        boolean begin(String configuredUrl) {
            if (isBusy() || !isSafeHttpUrl(configuredUrl)) return false;
            originSnapshot = configuredUrl;
            return true;
        }

        boolean isBusy() {
            return originSnapshot != null || pickerInFlight;
        }

        boolean isAuthorized(String topLevelUrl, String configuredUrl) {
            return originSnapshot != null
                    && sameOrigin(originSnapshot, topLevelUrl)
                    && sameOrigin(originSnapshot, configuredUrl);
        }

        boolean markPickerInFlight(String topLevelUrl, String configuredUrl) {
            if (pickerInFlight || !isAuthorized(topLevelUrl, configuredUrl)) return false;
            pickerInFlight = true;
            return true;
        }

        boolean isPickerInFlight() {
            return pickerInFlight;
        }

        void pickerStartFailed() {
            pickerInFlight = false;
        }

        boolean complete(String topLevelUrl, String configuredUrl) {
            if (!pickerInFlight || originSnapshot == null) return false;
            boolean authorized = isAuthorized(topLevelUrl, configuredUrl);
            clear();
            return authorized;
        }

        void cancel() {
            clear();
        }

        private void clear() {
            originSnapshot = null;
            pickerInFlight = false;
        }
    }

    /** HTML 转义：错误页要把地址原样显示出来，不能让地址里的尖括号变成标签。 */
    private static String escapeHtml(String s) {
        StringBuilder b = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i += 1) {
            char c = s.charAt(i);
            switch (c) {
                case '&': b.append("&amp;"); break;
                case '<': b.append("&lt;"); break;
                case '>': b.append("&gt;"); break;
                case '"': b.append("&quot;"); break;
                case '\'': b.append("&#39;"); break;
                default: b.append(c);
            }
        }
        return b.toString();
    }

    /* ------------------------------------------------------------------ */
    /* 拍照 / 选图                                                         */
    /* ------------------------------------------------------------------ */

    /** 组装拍照意图；路径放在应用私有的 shared/，不需要存储权限。 */
    private Intent buildCaptureIntent() {
        try {
            File dir = FileStoreProvider.sharedDir(this);
            if (!dir.exists() && !dir.mkdirs()) return null;
            pruneCaptures(dir);

            File out = new File(dir, "capture-" + System.currentTimeMillis() + ".jpg");
            Uri uri = FileStoreProvider.uriFor(this, out);

            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (intent.resolveActivity(getPackageManager()) == null) return null;

            cameraUri = uri;
            return intent;
        } catch (Exception e) {
            Log.w(TAG, "cannot build capture intent", e);
            return null;
        }
    }

    /** 只留最近几张拍照临时文件，盗空间也不会无限长。 */
    private void pruneCaptures(File dir) {
        try {
            File[] files = dir.listFiles((d, name) -> name.startsWith("capture-"));
            if (files == null || files.length <= KEEP_CAPTURES) return;
            java.util.Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (int i = KEEP_CAPTURES; i < files.length; i += 1) {
                //noinspection ResultOfMethodCallIgnored
                files[i].delete();
            }
        } catch (Exception e) {
            Log.w(TAG, "prune captures failed", e);
        }
    }

    /** 把 HTML accept 值收敛为 Android picker 可识别的 MIME 列表；无效的非空过滤器拒绝。 */
    private ArrayList<String> resolveAcceptTypes(String[] rawTypes) {
        ArrayList<String> accepted = new ArrayList<>();
        if (rawTypes == null) return accepted;
        boolean requestedFilter = false;
        for (String raw : rawTypes) {
            if (raw == null) continue;
            for (String part : raw.split(",")) {
                String value = part.trim().toLowerCase(Locale.ROOT);
                if (value.isEmpty()) continue;
                requestedFilter = true;
                if (value.startsWith(".")) {
                    value = MimeTypeMap.getSingleton().getMimeTypeFromExtension(value.substring(1));
                    if (value == null) continue;
                }
                if (!isValidMimeType(value)) continue;
                if (!accepted.contains(value)) accepted.add(value);
            }
        }
        if (requestedFilter && accepted.isEmpty()) return null;
        if (accepted.contains("*/*")) {
            accepted.clear();
            accepted.add("*/*");
        }
        return accepted;
    }

    private static boolean isValidMimeType(String value) {
        return "*/*".equals(value)
                || value.matches("[a-z0-9!#$&^_.+\\-]+/(?:[a-z0-9!#$&^_.+\\-]+|\\*)");
    }

    private boolean acceptsImage(ArrayList<String> acceptedTypes) {
        if (acceptedTypes.isEmpty()) return true;
        for (String type : acceptedTypes) {
            if ("*/*".equals(type) || type.startsWith("image/")) return true;
        }
        return false;
    }

    private void showFileChooserConfirmation(WebChromeClient.FileChooserParams params, ArrayList<String> acceptedTypes) {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("选择文件")
                .setMessage("Android 文件选择 API 无法可靠识别发起 frame 的来源。"
                        + "仅校验了当前顶层页面与服务器同源。选择后，文件会交给页面；"
                        + "请勿为不可信卡片选择私人文件。")
                .setCancelable(true)
                .setPositiveButton("继续", (d, which) -> launchFileChooser(params, acceptedTypes))
                .setNegativeButton("取消", (d, which) -> finishFileChooser(null))
                .setOnCancelListener(d -> finishFileChooser(null))
                .create();
        dialog.setOnDismissListener(d -> {
            if (fileChoiceDialog == dialog) fileChoiceDialog = null;
        });
        fileChoiceDialog = dialog;
        dialog.show();
    }

    private void launchFileChooser(WebChromeClient.FileChooserParams params, ArrayList<String> acceptedTypes) {
        String topLevelUrl = web == null ? null : web.getUrl();
        if (errorPageShown || !fileChooserState.isAuthorized(topLevelUrl, startUrl)) {
            finishFileChooser(null);
            Toast.makeText(this, "页面来源已变化，已取消文件选择", Toast.LENGTH_LONG).show();
            return;
        }

        boolean multiple = params != null
                && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        if (params != null && params.isCaptureEnabled() && acceptsImage(acceptedTypes)) {
            Intent capture = buildCaptureIntent();
            if (capture != null) {
                if (!fileChooserState.markPickerInFlight(web == null ? null : web.getUrl(), startUrl)) {
                    finishFileChooser(null);
                    return;
                }
                try {
                    startActivityForResult(capture, REQ_FILE_CHOOSER);
                    return;
                } catch (Exception e) {
                    fileChooserState.pickerStartFailed();
                    Log.w(TAG, "camera intent failed, falling back to picker", e);
                    cameraUri = null;
                }
            }
        }

        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        if (acceptedTypes.isEmpty()) {
            pick.setType("*/*");
        } else if (acceptedTypes.size() == 1) {
            pick.setType(acceptedTypes.get(0));
        } else {
            pick.setType("*/*");
            pick.putExtra(Intent.EXTRA_MIME_TYPES, acceptedTypes.toArray(new String[0]));
        }
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (multiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

        Intent chooser = Intent.createChooser(pick, "选择文件");
        if (!fileChooserState.markPickerInFlight(web == null ? null : web.getUrl(), startUrl)) {
            finishFileChooser(null);
            return;
        }
        try {
            startActivityForResult(chooser, REQ_FILE_CHOOSER);
        } catch (Exception e) {
            fileChooserState.pickerStartFailed();
            Log.w(TAG, "no file picker available", e);
            finishFileChooser(null);
            Toast.makeText(this, "没有可用的文件选择器", Toast.LENGTH_LONG).show();
        }
    }

    private Uri[] filterAcceptedFiles(Uri[] result, ArrayList<String> acceptedTypes) {
        if (result == null || acceptedTypes == null) return null;
        for (Uri uri : result) {
            if (uri == null || !isAllowedContentUri(uri.getScheme(), uri.getAuthority())) return null;
            if (acceptedTypes.isEmpty()) continue;
            String actualMimeType;
            try {
                actualMimeType = getContentResolver().getType(uri);
            } catch (Exception e) {
                actualMimeType = null;
            }
            if (!acceptsFileMimeType(actualMimeType, acceptedTypes)) return null;
        }
        return result;
    }

    private void finishFileChooser(Uri[] result) {
        Uri[] delivered = filterAcceptedFiles(result, pendingAcceptTypes);
        if (result != null && delivered == null) {
            Toast.makeText(this, "所选文件类型或 URI 与页面要求不匹配", Toast.LENGTH_LONG).show();
        }
        fileChooserState.cancel();
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        pendingAcceptTypes = null;
        cameraUri = null;
        if (callback != null) callback.onReceiveValue(delivered);
    }

    private void handleDownloadStart(String url, String userAgent, String contentDisposition, String mimeType) {
        if (errorPageShown || web == null || !sameOrigin(web.getUrl(), startUrl)
                || !isWorkspaceContentUrl(url, startUrl)) {
            Toast.makeText(this, "只允许下载同源 workspace content 文件", Toast.LENGTH_LONG).show();
            return;
        }
        // 下载地址形如 /api/mobile/workspace/content?mountId=...&name=xxx.docx；
        // WebView 给的 contentDisposition 常年是空的，guessFileName 只能把末段猜成
        // content-<uuid>.bin，所以先认 name 参数，拿不到再退回原来那套。
        String fromQuery = downloadFileNameFromQuery(url);
        String suggested = fromQuery != null
                ? fromQuery
                : android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
        String safeName = sanitizeDownloadFileName(suggested);
        // safeName 已经洗过，uniqueDownloadFileName 内部还会再洗一次（幂等，防直调漏洗）；
        // 所以这里不存在重叠拼接，也不会有未清洗的字符串流到 setDestinationInExternalPublicDir。
        String fileName = uniqueDownloadFileName(safeName,
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS));
        if (fileName == null) {
            Toast.makeText(this, "下载文件名无效", Toast.LENGTH_LONG).show();
            return;
        }
        Uri target = Uri.parse(url);
        String scheme = target.getScheme() == null ? "" : target.getScheme();
        String message = "来源主机：" + target.getHost() + "\n文件名：" + fileName;
        if ("http".equalsIgnoreCase(scheme)) {
            message += "\nHTTP 未加密，文件可能被同一网络中的设备查看或篡改。";
        }
        new AlertDialog.Builder(this)
                .setTitle("确认下载")
                .setMessage(message)
                .setCancelable(true)
                .setPositiveButton("下载", (d, which) -> enqueueWorkspaceDownload(target, userAgent, mimeType, fileName))
                .setNegativeButton("取消", null)
                .show();
    }

    /**
     * 从 URL 的 name 查询参数取文件名，并过一遍与本地一致的清洗。
     *
     * 用 java.net.URI + URLDecoder 而不是 android.net.Uri：这段逻辑是纯 JDK 的，
     * 能在裸 JVM 上被测试抽取执行，测的就是真正进包的那几行代码。
     */
    static String downloadFileNameFromQuery(String rawUrl) {
        if (rawUrl == null || rawUrl.isEmpty()) return null;
        try {
            URI uri = new URI(rawUrl);
            String query = uri.getRawQuery();
            if (query == null || query.isEmpty()) return null;
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq <= 0) continue;
                if (!"name".equals(pair.substring(0, eq))) continue;
                String decoded = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                return sanitizeDownloadFileName(decoded);
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private void enqueueWorkspaceDownload(Uri target, String userAgent, String mimeType, String fileName) {
        if (errorPageShown || web == null || !sameOrigin(web.getUrl(), startUrl)
                || !isWorkspaceContentUrl(target.toString(), startUrl)) {
            Toast.makeText(this, "页面来源已变化，已取消下载", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
            DownloadManager.Request request = new DownloadManager.Request(target);
            request.setTitle(fileName);
            request.setDescription("来自 " + target.getHost());
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            if (isValidMimeType(mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT))) {
                request.setMimeType(mimeType);
            }
            String cookie = CookieManager.getInstance().getCookie(target.toString());
            if (cookie != null && !cookie.isEmpty()) request.addRequestHeader("Cookie", cookie);
            if (isSafeHeaderValue(userAgent, 512)) request.addRequestHeader("User-Agent", userAgent);
            manager.enqueue(request);
            Toast.makeText(this, "已加入下载列表", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Log.w(TAG, "download enqueue failed");
            Toast.makeText(this, "下载未能启动", Toast.LENGTH_LONG).show();
        }
    }

    private static boolean isSafeHeaderValue(String value, int maxLength) {
        if (value == null || value.isEmpty() || value.length() > maxLength) return false;
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7f) return false;
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }

        if (!fileChooserState.isPickerInFlight()) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        boolean sameOriginAtDelivery = fileChooserState.complete(
                web == null ? null : web.getUrl(), startUrl);
        Uri[] result = null;
        if (sameOriginAtDelivery && resultCode == RESULT_OK) {
            ClipData clip = data == null ? null : data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i += 1) {
                    result[i] = clip.getItemAt(i).getUri();
                }
            } else if (data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            } else if (cameraUri != null) {
                // 相机 App 把结果写进了我们给的 Uri，不回传 data
                result = new Uri[]{cameraUri};
            }
        }
        if (!sameOriginAtDelivery) result = null;
        finishFileChooser(result);
    }

    /* ------------------------------------------------------------------ */
    /* 返回键                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * API 33+ 注册系统返回回调。
     *
     * targetSdk 36 + Android 16 默认走预测性返回，KEYCODE_BACK 不再派发到 onKeyDown()；
     * 只留 onKeyDown 的话新机型上返回键会直接变成「退出 App」。33 以下没有这个 API，
     * 继续走 onKeyDown。两条路只会有一条被调用，不会重复处理同一次返回。
     */
    private void installBackDispatcher() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::askWebToGoBack);
        } catch (Exception e) {
            Log.w(TAG, "onBackInvokedDispatcher unavailable, falling back to onKeyDown", e);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.getRepeatCount() == 0) askWebToGoBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * 先问网页能不能往上退一步（聊天 → 列表），退不动才走原来的退出策略。
     *
     * 不能直接看 canGoBack()：聊天界面是 SPA，历史里只有一条记录，它恒为 false。
     * evaluateJavascript 是异步的，结果在回调里处理；连按时用序号把旧答复作废。
     */
    private void askWebToGoBack() {
        if (urlDialog != null && urlDialog.isShowing()) {
            urlDialog.dismiss();                 // 地址对话框开着时，返回键等于取消
            return;
        }
        if (foreignPageDialog != null && foreignPageDialog.isShowing()) {
            foreignPageDialog.dismiss();         // 「不是 Hana 的页面」对话框同理
            return;
        }
        if (web == null) {
            finish();
            return;
        }
        final int seq = ++backSeq;
        try {
            web.evaluateJavascript(JS_BACK, (value) -> {
                if (seq != backSeq) return;      // 期间又按了一下，这次答复作废
                leaveOrFinish("true".equals(value));
            });
        } catch (Exception e) {
            Log.w(TAG, "evaluateJavascript failed", e);
            if (seq == backSeq) leaveOrFinish(false);   // 答不出来就算没退
        }
    }

    /**
     * 返回键决策表（纯 Java，可被裸 JVM 测试直接验证）。
     *
     * 顺序就是优先级：网页自己退了 → 什么都不做；错误页（我们自己 render 的）→ 退出；
     * 有可退历史 → 退历史；确认是 Hana 的页面 → 退出；其余 → 问用户。
     *
     * pageIsHana 是三态：只有 Boolean.TRUE 才允许直接退出；false（别人的页面）和
     * null（还没查到 / 查不到）都落到 BACK_ASK，不能当成「可以退出了」。
     */
    static String backAction(boolean webHandled, boolean errorPageShown,
                             boolean canGoBack, Boolean pageIsHana) {
        if (webHandled) return BACK_NONE;
        if (errorPageShown) return BACK_FINISH;
        if (canGoBack) return BACK_GO_BACK;
        if (Boolean.TRUE.equals(pageIsHana)) return BACK_FINISH;
        return BACK_ASK;
    }

    /**
     * 原生「可回退」只认一种历史：当前配置地址同源的有效 HTTP(S) 页面。
     *
     * WebView 的历史可能包含设置页、空白页或用户换过的旧接入地址，
     * 甚至 about:blank / data: —— 退回去不是白屏就是别人的页面，比直接退出更难解释。
     * 所以 canGoBack() 只当粗筛，真正的判据是上一条 history item 的 origin；
     * 判定沿用 sameOrigin()（它内部走 isSafeHttpUrl，会拒掉 null、about:blank、data:、带 userinfo）。
     * 这里只收紧「有没有可退历史」，backAction() 的优先级顺序一个字不动。
     */
    private boolean canGoBackWithinOrigin() {
        if (web == null || startUrl == null || !web.canGoBack()) return false;
        WebBackForwardList history = web.copyBackForwardList();
        if (history == null) return false;
        int index = history.getCurrentIndex();
        if (index <= 0) return false;
        WebHistoryItem previous = history.getItemAtIndex(index - 1);
        if (previous == null) return false;
        return sameOrigin(previous.getUrl(), startUrl);
    }

    /** 按决策表执行副作用；判断本身在 backAction()，这里只负责做。 */
    private void leaveOrFinish(boolean webHandled) {
        String action = backAction(webHandled, errorPageShown,
                canGoBackWithinOrigin(), pageIsHana);
        if (BACK_GO_BACK.equals(action)) {
            if (web != null) web.goBack();
            return;
        }
        if (BACK_FINISH.equals(action)) {
            finish();
            return;
        }
        if (BACK_ASK.equals(action)) {
            promptForForeignPage();
        }
        // BACK_NONE：网页自己退了一步，原生什么都不做
    }

    /* ------------------------------------------------------------------ */
    /* 回合完成通知（平台原生 Notification，不引 androidx）                  */
    /* ------------------------------------------------------------------ */

    /**
     * 建通知通道。API 26+ 每进程建一次就够，重复建是幂等的（同 ID 只会更新，不会覆盖
     * 用户后来改过的设置）。
     *
     * 重要性用默认档 IMPORTANCE_DEFAULT：有提示音，但不弹横幅。通道重要性只能调低不能
     * 调高，所以壳不替用户做决定：真想安静就自己去系统设置里改。
     */
    private void ensureNotificationChannel() {
        if (notificationChannelReady) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID_TURNS, CHANNEL_NAME_TURNS, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("一轮回复跑完时提醒一声；应用在前台时不发");
        // 锁屏上不展开正文：正文本来只有一句「回复已完成」，多设一层更稳。
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
        notificationChannelReady = true;
    }

    /**
     * 弹一条「回复完成」。
     *
     * 标题是助手名，正文只说「完成了 / 被截断」——绝不塞正文摘要：锁屏上通知内容
     * 是旁人看得见的。前台且有焦点时不发，用户在别的应用里才发。
     */
    private void showTurnNotification(String title, String body) {
        if (activityResumed && windowFocused) {
            Log.i(TAG, "turn notification skipped: foreground");
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (!nm.areNotificationsEnabled()) {          // 用户在系统设置里把通知关了
            Log.i(TAG, "turn notification skipped: disabled");
            return;
        }
        ensureNotificationChannel();

        String safeTitle = clampNotificationText(title, NOTIFICATION_TITLE_MAX);
        String safeBody = clampNotificationText(body, NOTIFICATION_BODY_MAX);
        if (safeTitle.isEmpty()) safeTitle = getString(R.string.app_name);
        if (safeBody.isEmpty()) safeBody = "回复已完成";

        // 点通知就回到原来的任务（launchMode=singleTask + SINGLE_TOP，不会重开一栈）。
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new Notification.Builder(this, CHANNEL_ID_TURNS)
                .setSmallIcon(R.drawable.ic_launcher_bot)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setContentIntent(tap)
                .build();
        try {
            nm.notify(NOTIFICATION_ID_TURN, notification);
            Log.i(TAG, "turn notification posted");
        } catch (Throwable t) {
            // 个别机型上通知服务会拒（通道被删、通知被系统静音）；不能因此崩掉壳
            Log.w(TAG, "turn notification failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* JS → 原生通道（WebMessageChannel，只做通知）                          */
    /* ------------------------------------------------------------------ */

    /**
     * 页面（主 frame）加载完后，给网页递一个原生消息端口。
     *
     * 为何选 WebMessageChannel（而不是自定义 scheme）：
     *  - 壳里不能加 addJavascriptInterface（它对所有 frame 生效，卡片 iframe 也会拿到）；
     *  - 自定义 scheme 只能靠 URL 导航，shouldOverrideUrlLoading 只知道「目标是不是主 frame」
     *    而不知道是谁发起的：卡片 iframe 一句 top.location 就能冒充页面发通知；
     *  - createWebMessageChannel() + postWebMessage() 的投递对象是**主 frame**，而且只在
     *    文档 origin 与 targetOrigin 相符时才投——卡片拿不到端口，跨源页也收不到。
     *
     * 两个残余风险靠“少做事”封住：只认 notify / requestPermission 两种动作，
     * 报文有字符上限，版本不符 / 不是 JSON / 超长一律丢掉。
     */
    private void beginBridgeHandshake() {
        if (web == null || bridgeHandler == null) return;
        resetNativeBridge();
        final int round = bridgeRound;
        for (int i = 0; i < BRIDGE_RETRY_MS.length; i += 1) {
            if (i == 0) {
                postBridgePort(round);
                continue;
            }
            final long delay = BRIDGE_RETRY_MS[i];
            bridgeHandler.postDelayed(() -> {
                if (round != bridgeRound || bridgeAcked) return;   // 页面换了 / 已经握手成功
                postBridgePort(round);
            }, delay);
        }
    }

    /** 投一轮端口。实发失败（旧 WebView 提供者没实现通道）就认定没有原生桥，不再重试。 */
    private void postBridgePort(int round) {
        if (round != bridgeRound || web == null || startUrl == null) return;
        if (errorPageShown) return;                             // 错误页里没有我们的脚本
        if (!sameOrigin(web.getUrl(), startUrl)) return;        // 只给同源文档递端口
        String origin = originOf(startUrl);
        if (origin == null) return;
        try {
            WebMessagePort[] channel = web.createWebMessageChannel();
            if (channel == null || channel.length < 2
                    || channel[0] == null || channel[1] == null) return;
            WebMessagePort nativePort = channel[0];
            WebMessagePort pagePort = channel[1];
            closeBridgePort();                                  // 关掉上一轮的端口（页面会改用新的那条）
            bridgePort = nativePort;
            nativePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                @Override
                public void onMessage(WebMessagePort port, WebMessage message) {
                    handleBridgeMessage(port, message == null ? null : message.getData());
                }
            });
            // 端口随 WebMessage 一起投出去：投递对象是主 frame，且只投给 origin 相符的文档。
            web.postWebMessage(new WebMessage(BRIDGE_HELLO, new WebMessagePort[]{pagePort}), Uri.parse(origin));
        } catch (Throwable t) {
            // 极少数 WebView 提供者没实现 WebMessage 通道：当作没有原生桥，页面安静降级
            Log.w(TAG, "native bridge unavailable", t);
            closeBridgePort();
            bridgeRound += 1;                                   // 本轮剩下的重投全部作废
        }
    }

    /**
     * 端口上来的每一条消息。
     *
     * 只认两种动作：notify / requestPermission。另外认一个无副作用的 hello（握手回执），
     * 它不是一个动作。这不是通用 RPC，别往里加东西。
     */
    private void handleBridgeMessage(WebMessagePort port, String data) {
        if (port == null || data == null) return;
        if (data.length() > BRIDGE_MAX_CHARS) {
            // 只记长度，不把内容写进 logcat
            Log.w(TAG, "bridge message dropped: too long (" + data.length() + ")");
            return;
        }
        JSONObject msg;
        try {
            msg = new JSONObject(data);
        } catch (Exception e) {
            Log.w(TAG, "bridge message dropped: not json");
            return;
        }
        if (msg.optInt("v", 0) != BRIDGE_PROTOCOL_VERSION) {
            Log.w(TAG, "bridge message dropped: bad version");
            return;
        }
        if (msg.optBoolean("hello", false)) {
            if (port == bridgePort) bridgeAcked = true;
            Log.i(TAG, "native bridge ready");
            return;
        }
        String action = msg.optString("action", "");
        if ("notify".equals(action)) {
            showTurnNotification(msg.optString("title", ""), msg.optString("body", ""));
            return;
        }
        if ("requestPermission".equals(action)) {
            handlePermissionRequest(port, msg.optString("id", ""));
            return;
        }
        Log.w(TAG, "bridge message dropped: unsupported action");
    }

    /**
     * 页面要通知权限。
     *
     * API 33+ 才有 POST_NOTIFICATIONS 这个运行时权限（minSdk 26 的老系统直接按系统通知
     * 开关回答）。结果是异步的：先记下端口和请求 id，onRequestPermissionsResult 里再回给页面。
     */
    private void handlePermissionRequest(WebMessagePort port, String requestId) {
        String known = currentNotificationPermission();
        if (known != null) {
            replyPermission(port, requestId, known);
            return;
        }
        // 已经问过一次还是没给：不再弹第二次（用户很可能就是不想给）。
        // 后来在系统设置里批准了的话，currentNotificationPermission() 会直接回 granted。
        if (prefs != null && prefs.getBoolean(KEY_NOTIF_PERM_ASKED, false)) {
            replyPermission(port, requestId, PERM_DENIED);
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            replyPermission(port, requestId, PERM_UNSUPPORTED);
            return;
        }
        permissionPort = port;
        permissionRequestId = requestId;
        if (prefs != null) prefs.edit().putBoolean(KEY_NOTIF_PERM_ASKED, true).apply();
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
        } catch (Throwable t) {
            Log.w(TAG, "requestPermissions failed", t);
            permissionPort = null;
            permissionRequestId = null;
            replyPermission(port, requestId, PERM_UNSUPPORTED);
        }
    }

    /**
     * 当前通知权限的结论：granted / denied；null 表示「还没问过，可以问」。
     *
     * API 33 之前没有这个运行时权限，只看系统里的通知总开关——关掉就是 denied，
     * 我们没法替用户打开，也不该反复请求。
     */
    private String currentNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return PERM_UNSUPPORTED;
            return nm.areNotificationsEnabled() ? PERM_GRANTED : PERM_DENIED;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return PERM_GRANTED;
        }
        return null;
    }

    /** 把权限结论回给页面；端口可能已经失效，失败只记一行。 */
    private void replyPermission(WebMessagePort port, String requestId, String status) {
        if (port == null) return;
        try {
            JSONObject reply = new JSONObject();
            reply.put("v", BRIDGE_PROTOCOL_VERSION);
            reply.put("reply", "permission");
            reply.put("id", requestId == null ? "" : requestId);
            reply.put("status", status);
            port.postMessage(new WebMessage(reply.toString()));
        } catch (Throwable ignored) {
            Log.w(TAG, "permission reply failed");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_POST_NOTIFICATIONS) return;
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        WebMessagePort port = permissionPort;
        String requestId = permissionRequestId;
        permissionPort = null;
        permissionRequestId = null;
        Log.i(TAG, "notification permission " + (granted ? PERM_GRANTED : PERM_DENIED));
        replyPermission(port, requestId, granted ? PERM_GRANTED : PERM_DENIED);
    }

    /** 页面换了 / Activity 销毁：端口作废，上一轮剩下的重投也一并作废。 */
    private void resetNativeBridge() {
        bridgeRound += 1;
        bridgeAcked = false;
        permissionPort = null;
        permissionRequestId = null;
        closeBridgePort();
    }

    private void closeBridgePort() {
        WebMessagePort dying = bridgePort;
        bridgePort = null;
        if (dying == null) return;
        try {
            dying.close();
        } catch (Throwable ignored) {
            // 端口已经失效：没什么可收拾的
        }
    }

    /**
     * RFC 6454 的 origin 序列化：scheme://host[:port]，默认端口省略。
     *
     * postWebMessage 的 targetOrigin 只认这个形状：带路径、带默认端口都可能对不上，
     * 对不上就等于端口投不出去（页面侧 3 秒后降级成「没有原生」）。
     * 纯 JDK 类型，和 normalizeStartUrl 一样可以直接在裸 JVM 上验。
     */
    static String originOf(String raw) {
        if (!isSafeHttpUrl(raw)) return null;
        try {
            URI uri = new URI(raw);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return null;
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if ("http".equals(scheme) && port == 80) port = -1;
            if ("https".equals(scheme) && port == 443) port = -1;
            return scheme + "://" + host + (port == -1 ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 通知文案：压成一行、去掉控制字符、按字符数截断。
     * 纯 Java（不碰 android.*），与 normalizeStartUrl 同一规格，可被裸 JVM 测试直接执行。
     */
    static String clampNotificationText(String raw, int max) {
        if (raw == null || max <= 0) return "";
        StringBuilder out = new StringBuilder(Math.min(raw.length(), max));
        for (int i = 0; i < raw.length() && out.length() < max; i += 1) {
            char c = raw.charAt(i);
            if (c == '\n' || c == '\r' || c == '\t') {
                out.append(' ');        // 换行在通知栏里会显示成怪东西
                continue;
            }
            if (Character.isISOControl(c)) continue;
            out.append(c);
        }
        return out.toString().trim();
    }

    /* ------------------------------------------------------------------ */
    /* Activity 生命周期                                                    */
    /* ------------------------------------------------------------------ */

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
    }

    /** 窗口失焦（拉下通知栏 / 系统对话框 / 别的应用浮在上面）也算「人不在看」。 */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        windowFocused = hasFocus;
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        if (web != null) {
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        // 本 Activity 拥有的三处原生对话框：dismiss 后立即断开字段引用
        if (urlDialog != null && urlDialog.isShowing()) urlDialog.dismiss();
        urlDialog = null;
        if (foreignPageDialog != null && foreignPageDialog.isShowing()) foreignPageDialog.dismiss();
        foreignPageDialog = null;
        if (fileChoiceDialog != null && fileChoiceDialog.isShowing()) fileChoiceDialog.dismiss();
        fileChoiceDialog = null;

        // WebView 必须先离屏再销毁；置空后迟到的回调不再摸旧实例
        WebView dyingWeb = web;
        web = null;
        if (dyingWeb != null) {
            dyingWeb.stopLoading();
            ViewParent parent = dyingWeb.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(dyingWeb);
            dyingWeb.destroy();
        }

        // 文件选择器还举着页面 callback：按既有取消路径回 null，并清空状态
        if (fileCallback != null) finishFileChooser(null);

        resetNativeBridge();
        if (bridgeHandler != null) {
            bridgeHandler.removeCallbacksAndMessages(null);
            bridgeHandler = null;
        }
        super.onDestroy();
    }
}
