"""FastAPI 進入點 —— 本機小型網頁伺服器 + 瀏覽器操作。

服務埠 localhost:4141(避開 odoo-v2 的 3939)。啟動時自動開瀏覽器。
所有畫面全中文、引導式操作;使用者不需寫任何程式或 SQL。
"""
from __future__ import annotations

import shutil
import threading
import webbrowser
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import db, identify, mapping, report
from .base_paths import (
    APP_DIR,
    OUTPUT_DIR,
    REPORT_TEMPLATES_DIR,
    UPLOADS_DIR,
    ensure_dirs,
)
from .parsers import ParseError
from .parsers import parse as parse_source

PORT = 4141

app = FastAPI(title="PMIS 營造廠商報表系統")
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")


@app.on_event("startup")
def _startup() -> None:
    ensure_dirs()
    db.init_db()


# --- 共用工具 ------------------------------------------------------------

def _save_upload(upload: UploadFile, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(upload.filename or "uploaded").name
    dest = dest_dir / filename
    with dest.open("wb") as f:
        shutil.copyfileobj(upload.file, f)
    return dest


def _render(request: Request, name: str, **ctx: Any) -> HTMLResponse:
    ctx["request"] = request
    return templates.TemplateResponse(name, ctx)


# --- 首頁(日常操作:丟檔案 → 自動產出報表)-----------------------------

@app.get("/", response_class=HTMLResponse)
def home(request: Request) -> HTMLResponse:
    return _render(
        request,
        "home.html",
        reports=db.list_reports(),
        outputs=db.list_outputs()[:20],
    )


# --- 廠商管理 ------------------------------------------------------------

@app.get("/vendors", response_class=HTMLResponse)
def vendors_page(request: Request) -> HTMLResponse:
    vendors = db.list_vendors()
    for v in vendors:
        v["signatures"] = db.list_signatures(v["id"])
    return _render(request, "vendors.html", vendors=vendors)


@app.post("/vendors")
def create_vendor(name: str = Form(...), tax_id: str = Form(""), note: str = Form("")):
    if name.strip():
        db.create_vendor(name.strip(), tax_id.strip(), note.strip())
    return RedirectResponse("/vendors", status_code=303)


@app.post("/vendors/{vendor_id}/delete")
def delete_vendor(vendor_id: int):
    db.delete_vendor(vendor_id)
    return RedirectResponse("/vendors", status_code=303)


@app.post("/vendors/{vendor_id}/signatures")
def add_signature(vendor_id: int, rule_type: str = Form(...), rule_value: str = Form(...)):
    if rule_value.strip():
        db.add_signature(vendor_id, rule_type, rule_value.strip())
    return RedirectResponse("/vendors", status_code=303)


@app.post("/signatures/{signature_id}/delete")
def delete_signature(signature_id: int):
    db.delete_signature(signature_id)
    return RedirectResponse("/vendors", status_code=303)


# --- 報表管理(上傳固定範本 → 自動抽出欄位)----------------------------

@app.get("/reports", response_class=HTMLResponse)
def reports_page(request: Request, error: str = "") -> HTMLResponse:
    reports = db.list_reports()
    for r in reports:
        r["fields"] = db.list_report_fields(r["id"])
    return _render(request, "reports.html", reports=reports, error=error)


@app.post("/reports")
def create_report(name: str = Form(...), template: UploadFile = None):
    name = name.strip()
    if not name:
        return RedirectResponse("/reports?error=請填寫報表名稱", status_code=303)
    if template is None or not template.filename:
        return RedirectResponse("/reports?error=請上傳報表範本檔", status_code=303)

    saved = _save_upload(template, REPORT_TEMPLATES_DIR)
    ext = saved.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        template_type = "excel"
    elif ext == ".docx":
        template_type = "word"
    else:
        saved.unlink(missing_ok=True)
        return RedirectResponse(
            "/reports?error=報表範本僅支援 Excel(.xlsx)或 Word(.docx)", status_code=303
        )

    try:
        fields = report.extract_fields(saved, template_type)
    except ParseError as exc:
        saved.unlink(missing_ok=True)
        return RedirectResponse(f"/reports?error={exc}", status_code=303)

    report_id = db.create_report(name, str(saved), template_type)
    db.set_report_fields(report_id, fields)
    return RedirectResponse("/reports", status_code=303)


@app.post("/reports/{report_id}/delete")
def delete_report(report_id: int):
    db.delete_report(report_id)
    return RedirectResponse("/reports", status_code=303)


# --- 對應設定(某廠商 × 某報表)----------------------------------------

@app.get("/mapping", response_class=HTMLResponse)
def mapping_page(request: Request, vendor_id: int = 0, report_id: int = 0) -> HTMLResponse:
    vendors = db.list_vendors()
    reports = db.list_reports()
    context: dict[str, Any] = {
        "vendors": vendors,
        "reports": reports,
        "vendor_id": vendor_id,
        "report_id": report_id,
        "rows": None,
        "report_name": "",
        "vendor_name": "",
    }

    if vendor_id and report_id:
        vt = db.get_vendor_template(vendor_id, report_id)
        report_fields = [f["field_name"] for f in db.list_report_fields(report_id)]
        vendor = db.get_vendor(vendor_id)
        rpt = db.get_report(report_id)
        context["vendor_name"] = vendor["name"] if vendor else ""
        context["report_name"] = rpt["name"] if rpt else ""

        source_fields: list[str] = []
        if vt:
            source_fields = [f["field_name"] for f in db.list_source_fields(vt["id"])]

        existing = db.list_mappings(vendor_id, report_id)
        if existing:
            # 已有對應設定:直接呈現讓使用者調整
            rows = [
                {
                    "report_field": m["report_field"],
                    "source_field": m.get("source_field") or "",
                    "auto": bool(m.get("source_field")),
                }
                for m in existing
            ]
        else:
            # 尚未設定:給自動建議(未對到者 auto=False,前端標紅字)
            suggestion = mapping.suggest(source_fields, report_fields)
            rows = suggestion["suggestions"]

        context["rows"] = rows
        context["source_fields"] = source_fields
        context["has_source"] = vt is not None

    return _render(request, "mapping.html", **context)


@app.post("/mapping/upload-source")
async def mapping_upload_source(
    vendor_id: int = Form(...), report_id: int = Form(...), source: UploadFile = None
):
    if source is None or not source.filename:
        return RedirectResponse(
            f"/mapping?vendor_id={vendor_id}&report_id={report_id}", status_code=303
        )
    saved = _save_upload(source, UPLOADS_DIR / f"v{vendor_id}_r{report_id}")
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        return RedirectResponse(
            f"/mapping?vendor_id={vendor_id}&report_id={report_id}&error={exc}",
            status_code=303,
        )

    vt_id = db.create_vendor_template(
        vendor_id, report_id, saved.name, parsed.source_type
    )
    db.set_source_fields(
        vt_id,
        [
            {"field_name": f, "sample_value": parsed.sample_value(f), "location": ""}
            for f in parsed.fields
        ],
    )
    return RedirectResponse(
        f"/mapping?vendor_id={vendor_id}&report_id={report_id}", status_code=303
    )


@app.post("/mapping/save")
async def mapping_save(request: Request):
    form = await request.form()
    vendor_id = int(form["vendor_id"])
    report_id = int(form["report_id"])
    # 表單以 map__<報表欄位> = <來源欄位> 命名
    pairs: list[dict[str, Any]] = []
    for key, value in form.items():
        if key.startswith("map__"):
            report_field = key[len("map__"):]
            pairs.append({"report_field": report_field, "source_field": value})
    mapping.save_mappings(vendor_id, report_id, pairs)
    return RedirectResponse(
        f"/mapping?vendor_id={vendor_id}&report_id={report_id}&saved=1", status_code=303
    )


# --- 日常產出(丟檔案 → 辨識 → 填範本 → 產出)-------------------------

@app.post("/process", response_class=HTMLResponse)
async def process(request: Request, report_id: int = Form(...), source: UploadFile = None):
    rpt = db.get_report(report_id)
    if rpt is None:
        return _render(request, "result.html", error="找不到指定的報表。", report_id=report_id)
    if source is None or not source.filename:
        return _render(request, "result.html", error="請選擇要上傳的廠商檔案。", report_id=report_id)

    saved = _save_upload(source, UPLOADS_DIR / "incoming")

    # 1. 解析格式
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        db.create_output(report_id, None, saved.name, "", "error", str(exc))
        return _render(request, "result.html", error=str(exc), report_id=report_id)

    # 2. 自動辨識廠商
    ident = identify.identify(parsed, saved.name)
    if ident.status != "matched":
        # 辨識失敗/多筆 → 跳出清單請使用者點選,絕不硬猜
        candidates = [db.get_vendor(vid) for vid in ident.candidates] if ident.candidates else db.list_vendors()
        candidates = [c for c in candidates if c]
        return _render(
            request,
            "confirm_vendor.html",
            reason=ident.reason,
            candidates=candidates,
            report_id=report_id,
            source_name=saved.name,
        )

    return _do_generate(request, report_id, ident.vendor_id, saved, parsed)


@app.post("/process/confirmed", response_class=HTMLResponse)
async def process_confirmed(
    request: Request,
    report_id: int = Form(...),
    vendor_id: int = Form(...),
    source_name: str = Form(...),
):
    saved = UPLOADS_DIR / "incoming" / source_name
    if not saved.exists():
        return _render(request, "result.html", error="來源檔已遺失,請重新上傳。", report_id=report_id)
    try:
        parsed = parse_source(saved)
    except ParseError as exc:
        return _render(request, "result.html", error=str(exc), report_id=report_id)
    return _do_generate(request, report_id, vendor_id, saved, parsed)


def _do_generate(request: Request, report_id: int, vendor_id: int, source_path: Path, parsed) -> HTMLResponse:
    rpt = db.get_report(report_id)
    vendor = db.get_vendor(vendor_id)
    report_fields = db.list_report_fields(report_id)
    mappings = db.list_mappings(vendor_id, report_id)

    if not mappings:
        msg = (
            f"廠商「{vendor['name'] if vendor else vendor_id}」尚未設定與此報表的對應,"
            "請先到「對應設定」完成後再產出。"
        )
        db.create_output(report_id, vendor_id, source_path.name, "", "error", msg)
        return _render(request, "result.html", error=msg, report_id=report_id)

    # 阻擋產出:仍有未對到來源的報表欄位(紅字未補齊)→ 明確提示
    unmapped = [m["report_field"] for m in mappings if not m.get("source_field")]

    safe_vendor = (vendor["name"] if vendor else str(vendor_id)).replace("/", "_").replace("\\", "_")
    safe_report = rpt["name"].replace("/", "_").replace("\\", "_")
    ext = ".xlsx" if rpt["template_type"] == "excel" else ".docx"
    from .db import now as _now
    stamp = _now().replace(":", "").replace("-", "").replace(" ", "_")
    output_filename = f"{safe_report}_{safe_vendor}_{stamp}{ext}"

    try:
        result = report.generate(
            template_path=rpt["template_path"],
            template_type=rpt["template_type"],
            report_fields=report_fields,
            mappings=mappings,
            source_rows=parsed.rows,
            output_filename=output_filename,
        )
    except ParseError as exc:
        db.create_output(report_id, vendor_id, source_path.name, "", "error", str(exc))
        return _render(request, "result.html", error=str(exc), report_id=report_id)

    warnings = list(result["warnings"])
    if unmapped:
        warnings.insert(
            0,
            "以下報表欄位尚未設定對應來源(已留空):" + "、".join(unmapped),
        )
    status = "warning" if warnings else "ok"
    out_id = db.create_output(
        report_id,
        vendor_id,
        source_path.name,
        result["output_path"],
        status,
        "\n".join(warnings),
    )

    return _render(
        request,
        "result.html",
        error="",
        report_id=report_id,
        vendor_name=vendor["name"] if vendor else str(vendor_id),
        report_name=rpt["name"],
        output_path=result["output_path"],
        output_id=out_id,
        warnings=warnings,
    )


# --- 產出記錄與下載 ------------------------------------------------------

@app.get("/outputs", response_class=HTMLResponse)
def outputs_page(request: Request) -> HTMLResponse:
    outputs = db.list_outputs()
    for o in outputs:
        v = db.get_vendor(o["vendor_id"]) if o["vendor_id"] else None
        r = db.get_report(o["report_id"])
        o["vendor_name"] = v["name"] if v else "(未辨識)"
        o["report_name"] = r["name"] if r else "(已刪除)"
    return _render(request, "outputs.html", outputs=outputs)


@app.get("/download/{output_id}")
def download(output_id: int):
    for o in db.list_outputs():
        if o["id"] == output_id and o["output_path"]:
            path = Path(o["output_path"])
            if path.exists():
                return FileResponse(path, filename=path.name)
    return RedirectResponse("/outputs", status_code=303)


# --- 啟動器 --------------------------------------------------------------

def _open_browser() -> None:
    webbrowser.open(f"http://localhost:{PORT}/")


def run() -> None:
    """由 啟動.bat 呼叫:啟動伺服器並自動開瀏覽器。"""
    import uvicorn

    threading.Timer(1.5, _open_browser).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    run()
