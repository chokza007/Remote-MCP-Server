from __future__ import annotations

import csv
import importlib
import json
import os
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Callable

from .protocol import ProtocolError


Progress = Callable[[float, str], None]
TEXT_EXTENSIONS = {".txt": "text", ".md": "markdown", ".markdown": "markdown"}
STRUCTURED_EXTENSIONS = {".json": "json", ".xml": "xml", ".csv": "csv"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}


def require_file(value: Any) -> Path:
    if not isinstance(value, str):
        raise ProtocolError("PROTOCOL_INVALID", "A string path is required.")
    path = Path(value).resolve()
    if not path.is_file():
        raise ProtocolError("DOCUMENT_INVALID", "The document does not exist or is not a regular file.", target=str(path))
    return path


def kind_for(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return TEXT_EXTENSIONS[suffix]
    if suffix in STRUCTURED_EXTENSIONS:
        return STRUCTURED_EXTENSIONS[suffix]
    if suffix == ".xlsx":
        return "xlsx"
    if suffix == ".docx":
        return "docx"
    if suffix == ".pdf":
        return "pdf"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    raise ProtocolError(
        "CAPABILITY_UNAVAILABLE",
        f"No document handler is available for {suffix or 'files without an extension'}.",
        target=str(path),
    )


def load_dependency(module: str, capability: str) -> Any:
    try:
        return importlib.import_module(module)
    except ImportError as exc:
        raise ProtocolError(
            "CAPABILITY_UNAVAILABLE",
            f"{capability} requires the optional Python package {module}.",
            suggested_action="Install the pinned helper requirements and restart the server.",
        ) from exc


def inspect_document(path: Path) -> dict[str, Any]:
    kind = kind_for(path)
    result: dict[str, Any] = {"kind": kind, "valid": True, "path": str(path), "sizeBytes": path.stat().st_size}
    if kind in {"text", "markdown"}:
        text = path.read_text(encoding="utf-8")
        result.update({"characters": len(text), "lines": len(text.splitlines())})
    elif kind == "json":
        with path.open(encoding="utf-8") as handle:
            json.load(handle)
    elif kind == "xml":
        ET.parse(path)
    elif kind == "csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            result["rows"] = sum(1 for _ in csv.reader(handle))
    elif kind == "xlsx":
        openpyxl = load_dependency("openpyxl", "XLSX support")
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=False)
        try:
            result["sheets"] = len(workbook.sheetnames)
            result["sheetNames"] = workbook.sheetnames
        finally:
            workbook.close()
    elif kind == "docx":
        with zipfile.ZipFile(path) as archive:
            if "word/document.xml" not in archive.namelist():
                raise ProtocolError("DOCUMENT_INVALID", "DOCX document.xml is missing.", target=str(path))
        result["container"] = "openxml"
    elif kind == "pdf":
        pypdf = load_dependency("pypdf", "PDF support")
        reader = pypdf.PdfReader(str(path))
        result["pages"] = len(reader.pages)
        result["encrypted"] = bool(reader.is_encrypted)
    elif kind == "image":
        image_module = load_dependency("PIL.Image", "Image support")
        with image_module.open(path) as image:
            image.verify()
        with image_module.open(path) as image:
            result.update({"format": image.format, "width": image.width, "height": image.height, "mode": image.mode})
    return result


def extract_xlsx(path: Path) -> dict[str, Any]:
    openpyxl = load_dependency("openpyxl", "XLSX support")
    workbook = openpyxl.load_workbook(path, read_only=False, data_only=False)
    try:
        sheets = []
        for sheet in workbook.worksheets:
            rows = [[cell.value for cell in row] for row in sheet.iter_rows()]
            formula_cells = sum(1 for row in sheet.iter_rows() for cell in row if cell.data_type == "f")
            sheets.append({
                "name": sheet.title,
                "mergedRanges": [str(item) for item in sheet.merged_cells.ranges],
                "formulaCells": formula_cells,
                "rows": rows,
            })
        return {"kind": "xlsx", "sheets": sheets}
    finally:
        workbook.close()


def extract_docx(path: Path) -> dict[str, Any]:
    namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    paragraphs = []
    for paragraph in root.findall(".//w:p", namespaces):
        text = "".join((node.text or "") for node in paragraph.findall(".//w:t", namespaces))
        if text:
            paragraphs.append(text)
    return {"kind": "docx", "paragraphs": paragraphs, "text": "\n".join(paragraphs)}


def extract_document(path: Path) -> dict[str, Any]:
    kind = kind_for(path)
    if kind in {"text", "markdown"}:
        return {"kind": kind, "text": path.read_text(encoding="utf-8")}
    if kind == "json":
        with path.open(encoding="utf-8") as handle:
            return {"kind": kind, "data": json.load(handle)}
    if kind == "xml":
        root = ET.parse(path).getroot()
        return {"kind": kind, "root": root.tag, "text": "".join(root.itertext())}
    if kind == "csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return {"kind": kind, "rows": list(csv.reader(handle))}
    if kind == "xlsx":
        return extract_xlsx(path)
    if kind == "docx":
        return extract_docx(path)
    if kind == "pdf":
        pypdf = load_dependency("pypdf", "PDF support")
        reader = pypdf.PdfReader(str(path))
        pages = [{"page": index + 1, "text": page.extract_text() or ""} for index, page in enumerate(reader.pages)]
        return {"kind": kind, "pages": pages, "text": "\n".join(page["text"] for page in pages)}
    if kind == "image":
        return inspect_document(path)
    raise AssertionError("unreachable")


def render_pdf(path: Path, output_directory: Path, progress: Progress) -> dict[str, Any]:
    fitz = load_dependency("fitz", "PDF rendering")
    output_directory.mkdir(parents=True, exist_ok=True)
    document = fitz.open(str(path))
    outputs: list[str] = []
    try:
        for index, page in enumerate(document):
            output = output_directory / f"page-{index + 1:04d}.png"
            temporary = output.with_name(f".{output.name}.tmp.png")
            page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(str(temporary))
            inspect_document(temporary)
            os.replace(temporary, output)
            outputs.append(str(output.resolve()))
            progress((index + 1) / max(len(document), 1), f"Rendered page {index + 1}")
    finally:
        document.close()
    return {"kind": "pdf", "outputs": outputs}


def ocr_image(path: Path) -> str:
    rapidocr = load_dependency("rapidocr_onnxruntime", "OCR support")
    engine = rapidocr.RapidOCR()
    result = engine(str(path))
    lines = result[0] if isinstance(result, tuple) else result
    if not lines:
        return ""
    text_parts = []
    for line in lines:
        if isinstance(line, (list, tuple)) and len(line) >= 2:
            text_parts.append(str(line[1]))
    return "\n".join(text_parts)


def ocr_document(path: Path, progress: Progress) -> dict[str, Any]:
    kind = kind_for(path)
    if kind == "image":
        return {"kind": kind, "text": ocr_image(path)}
    if kind != "pdf":
        raise ProtocolError("CAPABILITY_UNAVAILABLE", "OCR currently supports images and PDFs.", target=str(path))
    with tempfile.TemporaryDirectory(prefix="remote-mcp-ocr-") as temporary:
        rendered = render_pdf(path, Path(temporary), progress)
        pages = []
        for index, output in enumerate(rendered["outputs"]):
            pages.append({"page": index + 1, "text": ocr_image(Path(output))})
            progress((index + 1) / max(len(rendered["outputs"]), 1), f"OCR page {index + 1}")
    return {"kind": "pdf", "pages": pages, "text": "\n".join(page["text"] for page in pages)}


def convert_document(path: Path, output: Path, requested_format: str) -> dict[str, Any]:
    kind = kind_for(path)
    requested_format = requested_format.lower().lstrip(".")
    output.parent.mkdir(parents=True, exist_ok=True)
    if kind == "image" and requested_format in {"png", "jpeg", "jpg", "webp", "tiff"}:
        image_module = load_dependency("PIL.Image", "Image conversion")
        temporary = output.with_name(f".{output.stem}.tmp{output.suffix}")
        with image_module.open(path) as image:
            prepared = image.convert("RGB") if requested_format in {"jpeg", "jpg"} and image.mode not in {"RGB", "L"} else image.copy()
            prepared.save(temporary, format="JPEG" if requested_format in {"jpeg", "jpg"} else requested_format.upper())
        os.replace(temporary, output)
        inspected = inspect_document(output)
        return {"kind": "image", "valid": True, "output": str(output.resolve()), "inspection": inspected}
    raise ProtocolError(
        "CAPABILITY_UNAVAILABLE",
        f"Conversion from {kind} to {requested_format} is not available.",
        target=str(path),
    )


def update_docx(path: Path, output: Path, replacements: Any) -> dict[str, Any]:
    if kind_for(path) != "docx" or not isinstance(replacements, list) or not replacements:
        raise ProtocolError("PROTOCOL_INVALID", "update_docx requires DOCX input and replacements.")
    temporary = output.with_name(f".{output.name}.tmp")
    replaced = 0
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    ET.register_namespace("w", namespace)
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary, "w") as destination:
            for item in source.infolist():
                data = source.read(item.filename)
                if item.filename == "word/document.xml":
                    root = ET.fromstring(data)
                    for paragraph in root.findall(f".//{{{namespace}}}p"):
                        nodes = paragraph.findall(f".//{{{namespace}}}t")
                        if not nodes:
                            continue
                        text = "".join(node.text or "" for node in nodes)
                        changed = False
                        for replacement in replacements:
                            if not isinstance(replacement, dict) or not isinstance(replacement.get("search"), str) or not isinstance(replacement.get("replace"), str) or not replacement["search"]:
                                raise ProtocolError("PROTOCOL_INVALID", "Each DOCX replacement requires non-empty search and string replace values.")
                            count = text.count(replacement["search"])
                            if count:
                                text = text.replace(replacement["search"], replacement["replace"])
                                replaced += count
                                changed = True
                        if changed:
                            nodes[0].text = text
                            for node in nodes[1:]:
                                node.text = ""
                    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                destination.writestr(item, data)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    inspected = inspect_document(output)
    return {"kind": "docx", "valid": True, "output": str(output.resolve()), "replaced": replaced, "inspection": inspected}


def update_xlsx(path: Path, output: Path, updates: Any) -> dict[str, Any]:
    if kind_for(path) != "xlsx" or not isinstance(updates, list) or not updates:
        raise ProtocolError("PROTOCOL_INVALID", "update_xlsx requires XLSX input and updates.")
    openpyxl = load_dependency("openpyxl", "XLSX support")
    temporary = output.with_name(f".{output.name}.tmp{output.suffix}")
    workbook = openpyxl.load_workbook(path, read_only=False, data_only=False)
    try:
        for update in updates:
            if not isinstance(update, dict) or not isinstance(update.get("sheet"), str) or not isinstance(update.get("cell"), str):
                raise ProtocolError("PROTOCOL_INVALID", "Each XLSX update requires sheet, cell, and value fields.")
            if update["sheet"] not in workbook.sheetnames:
                raise ProtocolError("DOCUMENT_INVALID", f"Unknown worksheet: {update['sheet']}", target=str(path))
            workbook[update["sheet"]][update["cell"]] = update.get("value")
        workbook.save(temporary)
        os.replace(temporary, output)
    finally:
        workbook.close()
        temporary.unlink(missing_ok=True)
    inspected = inspect_document(output)
    return {"kind": "xlsx", "valid": True, "output": str(output.resolve()), "updated": len(updates), "inspection": inspected}


def dispatch(method: str, params: dict[str, Any], progress: Progress) -> Any:
    path = require_file(params.get("path") if method not in {"render", "convert", "update_docx", "update_xlsx"} else params.get("input"))
    progress(0.05, f"Starting {method}")
    if method == "inspect":
        return inspect_document(path)
    if method == "extract":
        return extract_document(path)
    if method == "validate":
        return inspect_document(path)
    if method == "render":
        output_directory = params.get("outputDirectory")
        if not isinstance(output_directory, str):
            raise ProtocolError("PROTOCOL_INVALID", "render requires outputDirectory.")
        if kind_for(path) != "pdf":
            raise ProtocolError("CAPABILITY_UNAVAILABLE", "Rendering currently supports PDF input.", target=str(path))
        return render_pdf(path, Path(output_directory).resolve(), progress)
    if method == "ocr":
        return ocr_document(path, progress)
    if method == "convert":
        output = params.get("output")
        requested_format = params.get("format")
        if not isinstance(output, str) or not isinstance(requested_format, str):
            raise ProtocolError("PROTOCOL_INVALID", "convert requires output and format strings.")
        return convert_document(path, Path(output).resolve(), requested_format)
    if method in {"update_docx", "update_xlsx"}:
        output = params.get("output")
        if not isinstance(output, str):
            raise ProtocolError("PROTOCOL_INVALID", f"{method} requires an output string.")
        resolved_output = Path(output).resolve()
        resolved_output.parent.mkdir(parents=True, exist_ok=True)
        if method == "update_docx":
            return update_docx(path, resolved_output, params.get("replacements"))
        return update_xlsx(path, resolved_output, params.get("updates"))
    raise ProtocolError("CAPABILITY_UNAVAILABLE", f"Unknown document operation: {method}.")
