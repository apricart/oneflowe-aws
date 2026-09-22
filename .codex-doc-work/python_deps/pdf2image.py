"""Small compatibility layer for the packaged DOCX renderer on Windows.

It exposes the two pdf2image functions used by render_docx.py and delegates
PDF inspection and rasterization to PyMuPDF installed in this task workspace.
"""

from __future__ import annotations

import os

import fitz


def pdfinfo_from_path(pdf_path: str, *args, **kwargs) -> dict[str, object]:
    with fitz.open(pdf_path) as document:
        if document.page_count == 0:
            raise ValueError("PDF has no pages")
        rect = document[0].rect
        return {
            "Pages": document.page_count,
            "Page size": f"{rect.width:g} x {rect.height:g} pts",
        }


def convert_from_path(
    pdf_path: str,
    dpi: int = 200,
    fmt: str = "png",
    thread_count: int = 1,
    output_folder: str | None = None,
    paths_only: bool = False,
    output_file: str = "page",
    *args,
    **kwargs,
):
    if fmt.lower() != "png":
        raise ValueError("This renderer compatibility layer supports PNG only")
    if not output_folder:
        raise ValueError("output_folder is required")

    os.makedirs(output_folder, exist_ok=True)
    scale = dpi / 72.0
    matrix = fitz.Matrix(scale, scale)
    results: list[str] = []

    with fitz.open(pdf_path) as document:
        for index, page in enumerate(document, start=1):
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            output_path = os.path.join(output_folder, f"{output_file}0001-{index:02d}.png")
            pixmap.save(output_path)
            results.append(output_path)

    if not paths_only:
        raise ValueError("This renderer compatibility layer requires paths_only=True")
    return results
