package com.hanamobile.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;

/**
 * 极小的文件提供者，只暴露应用私有目录下的 shared/ 一个文件夹。
 *
 * 为什么需要它：targetSdk 36 下不能再把 file:// 的 Uri 递给相机 App（FileUriExposedException），
 * 而 androidx 的 FileProvider 又要求 Gradle 依赖。这个项目是手搓 APK，所以自己写一个够用的版本：
 *   - 只读/只写 shared/ 里的单层文件，路径穿越直接拒绝
 *   - 不导出，只靠 grantUriPermissions 临时授权给相机
 */
public class FileStoreProvider extends ContentProvider {

    public static final String AUTHORITY = "com.hanamobile.app.files";
    private static final String SHARED = "shared";

    public static File sharedDir(Context ctx) {
        return new File(ctx.getFilesDir(), SHARED);
    }

    public static Uri uriFor(Context ctx, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(SHARED)
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        List<String> segs = uri.getPathSegments();
        if (segs == null || segs.size() != 2 || !SHARED.equals(segs.get(0))) {
            throw new FileNotFoundException("unsupported uri: " + uri);
        }
        Context ctx = getContext();
        if (ctx == null) throw new FileNotFoundException("no context");
        File dir;
        try {
            dir = sharedDir(ctx).getCanonicalFile();
        } catch (IOException e) {
            throw new FileNotFoundException("bad dir");
        }
        File f = new File(dir, segs.get(1));
        try {
            if (!f.getCanonicalFile().getParentFile().equals(dir)) {
                throw new FileNotFoundException("path escapes store");
            }
        } catch (IOException e) {
            throw new FileNotFoundException("bad path");
        }
        return f;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        int flags;
        if (mode != null && mode.contains("w")) {
            File dir = f.getParentFile();
            if (dir != null && !dir.exists()) dir.mkdirs();
            flags = ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        } else {
            flags = ParcelFileDescriptor.MODE_READ_ONLY;
        }
        return ParcelFileDescriptor.open(f, flags);
    }

    @Override
    public String getType(Uri uri) {
        try {
            File f = resolve(uri);
            String name = f.getName();
            int dot = name.lastIndexOf('.');
            String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            return mime == null ? "application/octet-stream" : mime;
        } catch (FileNotFoundException e) {
            return "application/octet-stream";
        }
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
