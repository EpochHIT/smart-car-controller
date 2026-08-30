package com.epochhit.smartcar;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

@SuppressLint("MissingPermission")
public class MainActivity extends Activity {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int REQUEST_BLUETOOTH_PERMISSION = 1001;
    private static final int REQUEST_ENABLE_BLUETOOTH = 1002;
    private static final int REQUEST_SAVE_TEXT = 1003;
    private static final int ACTION_NONE = 0;
    private static final int ACTION_PICK_DEVICE = 1;
    private static final int ACTION_CONNECT_LAST = 2;
    private static final String PREFS = "smart_car";
    private static final String PREF_LAST_MAC = "last_mac";

    private final Object connectionLock = new Object();
    private WebView webView;
    private BluetoothAdapter bluetoothAdapter;
    private SharedPreferences preferences;
    private BluetoothSocket socket;
    private OutputStream outputStream;
    private boolean connecting;
    private int pendingBluetoothAction = ACTION_NONE;
    private String pendingFileName;
    private String pendingFileText;
    private volatile boolean destroyed;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 17, 31));
        getWindow().setNavigationBarColor(Color.rgb(7, 17, 31));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(7, 17, 31));
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new BluetoothBridge(), "AndroidBluetooth");
        setContentView(webView, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.loadUrl("file:///android_asset/index.html");
    }

    private boolean hasBluetoothPermissions() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
             checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED);
    }

    private void beginBluetoothAction(int action) {
        pendingBluetoothAction = action;
        if (bluetoothAdapter == null) {
            pendingBluetoothAction = ACTION_NONE;
            notifyNotice("这台手机不支持蓝牙", true);
            return;
        }
        if (!hasBluetoothPermissions()) {
            requestPermissions(
                new String[]{Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN},
                REQUEST_BLUETOOTH_PERMISSION
            );
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            startActivityForResult(
                new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),
                REQUEST_ENABLE_BLUETOOTH
            );
            return;
        }
        runPendingBluetoothAction();
    }

    private void runPendingBluetoothAction() {
        int action = pendingBluetoothAction;
        pendingBluetoothAction = ACTION_NONE;
        if (action == ACTION_CONNECT_LAST) connectLastDevice();
        else if (action == ACTION_PICK_DEVICE) showDevicePicker();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_BLUETOOTH_PERMISSION) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) granted &= result == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            beginBluetoothAction(pendingBluetoothAction);
        } else {
            pendingBluetoothAction = ACTION_NONE;
            notifyNotice("需要“附近设备”权限才能连接已配对的蓝牙模块", true);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ENABLE_BLUETOOTH) {
            if (resultCode == RESULT_OK) runPendingBluetoothAction();
            else {
                pendingBluetoothAction = ACTION_NONE;
                notifyNotice("蓝牙未开启，无法连接小车", true);
            }
            return;
        }
        if (requestCode == REQUEST_SAVE_TEXT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingFileText != null) {
                try (OutputStream stream = getContentResolver().openOutputStream(data.getData())) {
                    if (stream == null) throw new IOException("无法打开保存位置");
                    stream.write(pendingFileText.getBytes(StandardCharsets.UTF_8));
                    Toast.makeText(this, "CSV 已保存", Toast.LENGTH_SHORT).show();
                    notifyNotice("CSV 已保存", false);
                } catch (IOException error) {
                    notifyNotice("保存失败：" + error.getMessage(), true);
                }
            }
            pendingFileName = null;
            pendingFileText = null;
        }
    }

    private List<DeviceRow> bondedDeviceRows() {
        Set<BluetoothDevice> bonded = bluetoothAdapter.getBondedDevices();
        String lastMac = preferences.getString(PREF_LAST_MAC, "");
        List<DeviceRow> rows = new ArrayList<>();
        for (BluetoothDevice device : bonded) rows.add(new DeviceRow(device));
        rows.sort(Comparator
            .comparing((DeviceRow row) -> !row.device.getAddress().equalsIgnoreCase(lastMac))
            .thenComparing(row -> row.name.toLowerCase(Locale.ROOT))
            .thenComparing(row -> row.device.getAddress()));
        return rows;
    }

    private void showDevicePicker() {
        List<DeviceRow> allRows = bondedDeviceRows();
        if (allRows.isEmpty()) {
            new AlertDialog.Builder(this)
                .setTitle("还没有已配对设备")
                .setMessage("先在系统蓝牙中配对 JDY-31 或 HC-05，再回到这里连接。")
                .setPositiveButton("打开蓝牙设置", (dialog, which) ->
                    startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)))
                .setNegativeButton("取消", null)
                .show();
            return;
        }

        int padding = Math.round(18 * getResources().getDisplayMetrics().density);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(padding, 0, padding, 0);
        EditText search = new EditText(this);
        search.setSingleLine(true);
        search.setHint("搜索名称或 MAC 地址");
        ListView list = new ListView(this);
        List<DeviceRow> visibleRows = new ArrayList<>();
        ArrayAdapter<String> adapter = new ArrayAdapter<>(
            this,
            android.R.layout.simple_list_item_1,
            new ArrayList<>()
        );
        list.setAdapter(adapter);
        layout.addView(search, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        layout.addView(list, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            Math.round(320 * getResources().getDisplayMetrics().density)
        ));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("选择小车蓝牙")
            .setView(layout)
            .setNegativeButton("取消", null)
            .setNeutralButton("蓝牙设置", (current, which) ->
                startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)))
            .create();

        refreshDeviceRows(allRows, visibleRows, adapter, "");
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                refreshDeviceRows(allRows, visibleRows, adapter, text.toString());
            }
            @Override public void afterTextChanged(Editable text) {}
        });
        list.setOnItemClickListener((parent, view, position, id) -> {
            BluetoothDevice device = visibleRows.get(position).device;
            dialog.dismiss();
            connectDevice(device);
        });
        dialog.show();
    }

    private void refreshDeviceRows(
        List<DeviceRow> allRows,
        List<DeviceRow> visibleRows,
        ArrayAdapter<String> adapter,
        String query
    ) {
        String needle = query.trim().toLowerCase(Locale.ROOT);
        visibleRows.clear();
        adapter.clear();
        for (DeviceRow row : allRows) {
            if (needle.isEmpty() || row.searchText.contains(needle)) {
                visibleRows.add(row);
                adapter.add(row.label);
            }
        }
        adapter.notifyDataSetChanged();
    }

    private void connectLastDevice() {
        String lastMac = preferences.getString(PREF_LAST_MAC, "");
        if (lastMac.isEmpty()) {
            showDevicePicker();
            return;
        }
        for (DeviceRow row : bondedDeviceRows()) {
            if (row.device.getAddress().equalsIgnoreCase(lastMac)) {
                connectDevice(row.device);
                return;
            }
        }
        notifyNotice("上次设备已不在配对列表，请重新选择", true);
        showDevicePicker();
    }

    private void connectDevice(BluetoothDevice device) {
        synchronized (connectionLock) {
            if (connecting) {
                notifyNotice("蓝牙连接正在进行，请稍等", false);
                return;
            }
        }
        closeConnection(false, false);
        synchronized (connectionLock) {
            connecting = true;
        }
        String name = safeDeviceName(device);
        String mac = device.getAddress();
        notifyNotice("正在连接 " + name + "…", false);
        new Thread(() -> {
            IOException firstError = null;
            IOException lastError = null;

            for (int attempt = 0; attempt < 2; attempt++) {
                BluetoothSocket candidate = null;
                try {
                    /* JDY-31 使用非安全 SPP。短重试只用于等待旧串口通道释放，
                     * 不回退到安全连接，避免重新触发配对认证。 */
                    candidate = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                    synchronized (connectionLock) {
                        if (!connecting) {
                            candidate.close();
                            return;
                        }
                        socket = candidate;
                        outputStream = null;
                    }
                    bluetoothAdapter.cancelDiscovery();
                    candidate.connect();
                    InputStream input = candidate.getInputStream();
                    OutputStream output = candidate.getOutputStream();
                    synchronized (connectionLock) {
                        if (socket != candidate || !connecting) {
                            candidate.close();
                            return;
                        }
                        outputStream = output;
                        connecting = false;
                    }
                    preferences.edit().putString(PREF_LAST_MAC, mac).apply();
                    notifyBluetoothState(true, name, mac, "", false);
                    readLoop(candidate, input);
                    return;
                } catch (IOException error) {
                    if (firstError == null) firstError = error;
                    lastError = error;
                    if (candidate != null) {
                        try { candidate.close(); } catch (IOException ignored) {}
                    }
                    synchronized (connectionLock) {
                        if (socket == candidate) {
                            socket = null;
                            outputStream = null;
                        }
                    }
                    if (attempt == 0) {
                        try { Thread.sleep(300); } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
            }

            synchronized (connectionLock) {
                connecting = false;
                socket = null;
                outputStream = null;
            }
            String detail = lastError != null && lastError.getMessage() != null ?
                lastError.getMessage() : firstError != null ? firstError.toString() : "未知错误";
            notifyBluetoothState(false, name, mac,
                "连接失败：" + detail + "。请先断开串口助手或其他已连接页面，再重试。", false);
        }, "smart-car-connect").start();
    }

    private void readLoop(BluetoothSocket activeSocket, InputStream input) {
        byte[] buffer = new byte[1024];
        String failure = "蓝牙连接已断开";
        try {
            while (isActiveSocket(activeSocket)) {
                int count = input.read(buffer);
                if (count < 0) break;
                if (count > 0) {
                    String data = Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP);
                    evaluateJavascript("window.onAndroidBluetoothData && window.onAndroidBluetoothData('" + data + "');");
                }
            }
        } catch (IOException error) {
            failure = "蓝牙读取失败：" + error.getMessage();
        } finally {
            if (clearIfActive(activeSocket)) {
                try { activeSocket.close(); } catch (IOException ignored) {}
                notifyBluetoothState(false, "", "", failure, false);
            }
        }
    }

    private boolean isActiveSocket(BluetoothSocket candidate) {
        synchronized (connectionLock) {
            return socket == candidate;
        }
    }

    private boolean clearIfActive(BluetoothSocket candidate) {
        synchronized (connectionLock) {
            if (socket != candidate) return false;
            socket = null;
            outputStream = null;
            return true;
        }
    }

    private void closeConnection(boolean notify, boolean planned) {
        BluetoothSocket current;
        synchronized (connectionLock) {
            connecting = false;
            current = socket;
            socket = null;
            outputStream = null;
        }
        if (current != null) {
            try { current.close(); } catch (IOException ignored) {}
        }
        if (notify) notifyBluetoothState(false, "", "", "", planned);
    }

    private boolean writeBluetooth(String text) {
        OutputStream stream;
        BluetoothSocket activeSocket;
        synchronized (connectionLock) {
            stream = outputStream;
            activeSocket = socket;
        }
        if (stream == null || activeSocket == null) return false;
        try {
            stream.write(text.getBytes(StandardCharsets.US_ASCII));
            stream.flush();
            return true;
        } catch (IOException error) {
            if (clearIfActive(activeSocket)) {
                try { activeSocket.close(); } catch (IOException ignored) {}
                notifyBluetoothState(false, "", "", "发送失败：" + error.getMessage(), false);
            }
            return false;
        }
    }

    private String safeDeviceName(BluetoothDevice device) {
        String name = device.getName();
        return name == null || name.trim().isEmpty() ? "未命名设备" : name.trim();
    }

    private void notifyBluetoothState(boolean connected, String name, String mac, String message, boolean planned) {
        try {
            JSONObject state = new JSONObject();
            state.put("connected", connected);
            state.put("name", name);
            state.put("mac", mac);
            state.put("message", message);
            state.put("planned", planned);
            evaluateJavascript("window.onAndroidBluetoothState && window.onAndroidBluetoothState(" + state + ");");
        } catch (Exception ignored) {}
    }

    private void notifyNotice(String message, boolean error) {
        evaluateJavascript(
            "window.onAndroidBluetoothNotice && window.onAndroidBluetoothNotice(" +
                JSONObject.quote(message) + "," + error + ");"
        );
    }

    private void evaluateJavascript(String script) {
        if (destroyed || webView == null) return;
        runOnUiThread(() -> {
            if (!destroyed && webView != null) webView.evaluateJavascript(script, null);
        });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        closeConnection(false, false);
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBluetooth");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private final class BluetoothBridge {
        @JavascriptInterface
        public String getBuildTime() {
            return BuildConfig.BUILD_TIME;
        }

        @JavascriptInterface
        public boolean hasLastDevice() {
            return !preferences.getString(PREF_LAST_MAC, "").isEmpty();
        }

        @JavascriptInterface
        public void requestConnect() {
            runOnUiThread(() -> beginBluetoothAction(ACTION_PICK_DEVICE));
        }

        @JavascriptInterface
        public void connectLast() {
            runOnUiThread(() -> beginBluetoothAction(ACTION_CONNECT_LAST));
        }

        @JavascriptInterface
        public void disconnect() {
            closeConnection(true, true);
        }

        @JavascriptInterface
        public boolean write(String text) {
            return writeBluetooth(text);
        }

        @JavascriptInterface
        public boolean copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(ClipData.newPlainText("智能车数据", text));
                Toast.makeText(MainActivity.this, "已复制", Toast.LENGTH_SHORT).show();
            });
            return true;
        }

        @JavascriptInterface
        public void saveText(String fileName, String text) {
            runOnUiThread(() -> {
                pendingFileName = fileName;
                pendingFileText = text;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("text/csv");
                intent.putExtra(Intent.EXTRA_TITLE, fileName);
                startActivityForResult(intent, REQUEST_SAVE_TEXT);
            });
        }
    }

    private final class DeviceRow {
        final BluetoothDevice device;
        final String name;
        final String label;
        final String searchText;

        DeviceRow(BluetoothDevice device) {
            this.device = device;
            this.name = safeDeviceName(device);
            this.label = name + "\n" + device.getAddress();
            this.searchText = (name + " " + device.getAddress()).toLowerCase(Locale.ROOT);
        }
    }
}
