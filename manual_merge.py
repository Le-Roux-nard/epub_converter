import os, re
from typing import List
from mkepub import Book, BookMetadata
from pathlib import Path


def merge_dir(dir_path: Path):
    """Fonction appelée par le Timer pour lister le dossier et appeler le callback (si fourni)."""
    dir_path = Path(dir_path)

    try:
        nodes = os.listdir(dir_path)
    except Exception:
        nodes = []

    # nodes.sort(key=lambda a: int(re.findall(r"(?<=Chapitre )(\d+)", a)[0]) if re.findall(r"(?<=Chapitre )(\d+)", a) else 0)

    files = list(map(lambda node: os.path.join(dir_path, node), nodes))

    books : List[Book]= []
    for file in files:
        if os.path.isfile(file) and file.lower().endswith(".epub"):
            book = Book.read(file)
            books.append(book)
    
    books.sort(key=lambda book: book.metadata["collections"][0]["number"] if "collections" in book.metadata and len(book.metadata["collections"]) > 0 and "number" in book.metadata["collections"][0] else 0)

    root_folder = dir_path.parent
    book_title = root_folder.name if root_folder.name not in ["Chapitres", "Volumes"] else books[0].metadata["collections"][0]["name"] if len(books) > 0 and "collections" in books[0].metadata and len(books[0].metadata["collections"]) > 0 else root_folder.parent.name

    merged_metadata : BookMetadata = {
        "title": book_title,
        "collections": books[0].metadata["collections"] if len(books) > 0 and "collections" in books[0].metadata else [],
        "creators": [dict(t) for t in list({ tuple(sorted(creator.items())) for book in books for creator in book.metadata["creators"] })],
        "contributors": [dict(t) for t in list({ tuple(sorted(contributor.items())) for book in books for contributor in book.metadata["contributors"] })],
        "description": "\n\n".join(set([book.metadata["description"] for book in books if "description" in book.metadata and book.metadata["description"] is not None])),
        "lang": books[0].metadata["lang"] if len(books) > 0 and "lang" in books[0].metadata else "en",
        "rights": books[0].metadata["rights"] if len(books) > 0 and "rights" in books[0].metadata else "",
        "subjects": list(set([subject for book in books for subject in book.metadata.get("subjects", [])]))
    }

    if len(merged_metadata["collections"]) > 0 and "number" in merged_metadata["collections"][0]:
        merged_metadata["collections"][0]["number"] = int(merged_metadata["collections"][0]["number"])

    novel_folder = os.path.realpath(os.path.join(dir_path, ".."))

    merge_result = Book.merge(merged_metadata, *books)

    merge_result.set_cover(books[0].get_cover())

    filename = os.path.join(novel_folder, f"{merged_metadata['title']}.epub")
    if os.path.exists(filename):
        try:
            os.unlink(filename)
        except Exception:
            pass

    print(f"saving to {filename}")
    merge_result.save(filename=os.path.join(novel_folder, f"{merged_metadata['title']}.epub"), with_visible_toc=True, with_cover_as_first_page=True)

if __name__ == "__main__":
    import sys
    if len(sys.argv) != 2:
        print("Usage: python manual_merge.py <directory_path>")
        sys.exit(1)

    dir_path = sys.argv[1]
    if dir_path.endswith(os.sep):
        dir_path = dir_path[:-1]

    for (dirpath, dirnames, _) in os.walk(dir_path):
        if len(dirnames) > 0: continue
        merge_dir(dirpath)
