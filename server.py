import base64
import binascii
import io
import os
import json
import requests
import threading
import re
import math
from werkzeug.utils import secure_filename
from flask import Flask, request, send_from_directory, abort, send_file, render_template
from flask_cors import CORS
from urllib.parse import unquote
from typing import List, Callable
from datetime import datetime
from mkepub import Book, BookMetadata, BookCollectionMetadata
from natsort import natsorted
from dotenv import load_dotenv
from PIL import Image
from pathlib import Path

dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path)

url_turbo_regex = r"^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)$"
image_data_url_regexp = re.compile(
    r"^data:(image/[\w.+-]+)?;base64,(.*)$", re.IGNORECASE | re.DOTALL)

EPUB_ROOT_FOLDER = Path(os.environ.get("EPUB_ROOT_FOLDER", "./results/"))


class NovelMetadata:
    author:str
    collection:List[BookCollectionMetadata]
    translator:str
    synopsys:str
    cover:str
    volumeName:str

def convert_size(size_bytes):
    if size_bytes == 0:
        return None
    size_name = ("B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB")
    i = int(math.floor(math.log(size_bytes, 1024)))
    p = math.pow(1024, i)
    s = round(size_bytes / p, 2)
    return "%s %s" % (s, size_name[i])


def decode_data_url_to_bytes(data_url: str) -> bytes:
    m = image_data_url_regexp.match(data_url.strip())
    if not m:
        raise ValueError(
            "Format data URL invalide. Attendu: data:image/<type>;base64,<...>")

    b64_part = m.group(2)
    try:
        return base64.b64decode(b64_part, validate=True)
    except binascii.Error as e:
        raise ValueError(f"Contenu base64 invalide: {e}")


_debounce_lock = threading.Lock()
_debounce_timers: dict = {}


def debounce_execution(dir_path: Path, callback: Callable[[list], None], delay: float = 5.0):
    """Planifie une lecture (listing) du dossier `dir_path` après `delay` secondes d'inactivité.

    Si la fonction est rappelée avant la fin du délai, l'exécution est repoussée (debounce).
    `callback` est optionnel et reçoit la liste des fichiers au moment de l'exécution.
    """

    resolved_path = dir_path.resolve()
    with _debounce_lock:
        existing = _debounce_timers.get(resolved_path)
        if existing is not None:
            try:
                existing.cancel()
            except Exception:
                pass

        timer = threading.Timer(
            interval=delay, function=callback, args=[dir_path])
        timer.daemon = True
        _debounce_timers[resolved_path] = timer
        timer.start()


def _run_book_merging(volume_folder: Path):
    """Fonction appelée par le Timer pour lister le dossier et appeler le callback (si fourni)."""
    try:
        nodes = os.listdir(volume_folder)
    except Exception:
        nodes = []

    files = list(map(lambda node: volume_folder / node, nodes))

    books: List[Book] = []
    for file in files:
        if file.is_file() and file.name.lower().endswith(".epub"):
            book = Book.read(file)
            books.append(book)

    books.sort(key=lambda book: book.metadata["collections"][0]["number"] if "collections" in book.metadata and len(
        book.metadata["collections"]) > 0 and "number" in book.metadata["collections"][0] else 0)

    book_title = volume_folder.name if volume_folder.name not in ["Chapitres", "Volumes"] else books[0].metadata["collections"][0]["name"] if len(
        books) > 0 and "collections" in books[0].metadata and len(books[0].metadata["collections"]) > 0 else volume_folder.parent.name

    merged_metadata: BookMetadata = {
        "title": book_title,
        "collections": books[0].metadata["collections"] if len(books) > 0 and "collections" in books[0].metadata else [],
        "creators": [dict(t) for t in list({tuple(sorted(creator.items())) for book in books for creator in book.metadata["creators"]})],
        "contributors": [dict(t) for t in list({tuple(sorted(contributor.items())) for book in books for contributor in book.metadata["contributors"]})],
        "description": "\n\n".join(set([book.metadata["description"] for book in books if "description" in book.metadata])),
        "lang": books[0].metadata["lang"] if len(books) > 0 and "lang" in books[0].metadata else "en",
        "rights": books[0].metadata["rights"] if len(books) > 0 and "rights" in books[0].metadata else "",
        "subjects": list(set([subject for book in books for subject in book.metadata.get("subjects", [])]))
    }

    if len(merged_metadata["collections"]) > 0 and "number" in merged_metadata["collections"][0]:
        merged_metadata["collections"][0]["number"] = int(
            merged_metadata["collections"][0]["number"])

    novel_folder = volume_folder.parent

    merge_result = Book.merge(merged_metadata, *books)

    merge_result.set_cover(books[0].get_cover())

    filename = novel_folder / f"{merged_metadata['title']}.epub"
    if os.path.exists(filename):
        try:
            os.unlink(filename)
        except Exception:
            pass

    merge_result.save(filename=os.path.join(
        novel_folder, f"{merged_metadata['title']}.epub"), with_visible_toc=True, with_cover_as_first_page=True)


# ------------------------------------------


app = Flask(__name__)
CORS(app)


@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')


@app.route('/', methods=["GET", "HEAD"], defaults={'req_path': ''})
@app.route('/<path:req_path>')
def dir_listing(req_path: str):

    # Joining the base and the requested path
    abs_path = os.path.join(EPUB_ROOT_FOLDER, unquote(req_path))

    # Return 404 if path doesn't exist
    if not os.path.exists(abs_path):
        return abort(404)

    # Check if path is a file and serve
    if os.path.isfile(abs_path):
        if request.method == "GET":
            return send_file(abs_path)
        else:
            return "", 302

    if request.method != "GET":
        return "", 405

    actual_dir = req_path.split("/")[-1]
    previous_dir = "/".join(req_path.split("/")[:-1])

    # Show directory contents
    files = list(map(lambda node: {
        "name": node,
        "path": f"{actual_dir}/{node}",
        "isDir": os.path.isdir(os.path.join(abs_path, node)),
        "size": convert_size(os.path.getsize(os.path.join(abs_path, node))),
        "mdate": str(datetime.fromtimestamp(os.path.getmtime(os.path.join(abs_path, node))))[:19]
    }, os.listdir(abs_path)))

    return render_template('index.html', previous_dir=previous_dir, actual_dir=req_path, files=natsorted(files, key=lambda f: f["name"]))


@app.post('/')
def buildEpub():
    files = list(request.files.values())

    htmlFiles = list(filter(lambda f: f.filename == "chapter.html", files))
    jsonFiles = list(filter(lambda f: f.filename == "metadata.json", files))
    images = list(filter(lambda f: f.filename.endswith(".png"), files))

    if len(htmlFiles) != 1 or len(jsonFiles) != 1:
        return "Can't process files without exactly one 'chapter.html' and one 'metadata.json'", 422

    chapterContentFile = htmlFiles[0]
    metadataFile = jsonFiles[0]

    if chapterContentFile.content_type != "text/html":
        return abort(406)

    if metadataFile.content_type != "application/json":
        return abort(406)

    chapterContentFileStream = chapterContentFile.stream
    chapterContent = chapterContentFileStream.read().decode()
    chapterContentFileStream.close()

    metadataFileStream = metadataFile.stream
    metadataContent = metadataFileStream.read()
    metadataFileStream.close()

    try:
        metadata: BookMetadata = json.loads(metadataContent)
    except:
        return abort(406)

    target_folder = EPUB_ROOT_FOLDER
    if 'collections' in metadata and len(metadata['collections']) > 0:
        target_folder = target_folder / \
            secure_filename(metadata['collections'][0]['name'])

    if 'volumeName' in metadata:
        target_folder = target_folder / secure_filename(metadata['volumeName'])

    os.makedirs(target_folder, exist_ok=True)
    file_path = target_folder / f"{metadata['title']}.epub"

    if file_path.exists():
        return "", 208  # Already Reported

    if len(metadata["collections"]) > 0:
        for collection in metadata["collections"]:
            chapter_number = int(re.findall(r"(?<=Chapitre )(\d+)", metadata["title"])[
                                 0]) if re.findall(r"(?<=Chapitre )(\d+)", metadata["title"]) else 0
            collection_index = str(chapter_number).zfill(5)
            book_index = str(collection["number"]).split(".")[0]
            collection["number"] = f"{book_index}.{collection_index}"

    epubVolume = Book(**metadata)

    cover_content = None
    if re.match(url_turbo_regex, metadata["cover"]):
        cover_content = requests.get(metadata["cover"]).content
    elif re.match(image_data_url_regexp, metadata["cover"]):
        cover_content = decode_data_url_to_bytes(metadata["cover"])

    if cover_content is not None:
        cover_bytes = io.BytesIO(cover_content)
        im = Image.open(cover_bytes)
        im.verify()

        new_cover = io.BytesIO()
        im.convert("RGB").save(new_cover, format="PNG")
        epubVolume.set_cover(new_cover.getvalue())
    else:
        epubVolume.generate_cover()

    epubVolume.add_page(metadata["title"], chapterContent)
    for imageFile in images:
        imageFileStream = imageFile.stream
        imageContent = imageFileStream.read()
        imageFileStream.close()
        epubVolume.add_image(imageFile.filename, imageContent)

    epubVolume.save(filename=file_path.resolve(),
                    with_visible_toc=False, with_cover_as_first_page=False)

    # Planifie un listing debounced pour n'exécuter la lecture du dossier qu'une seule fois
    try:
        debounce_execution(target_folder, _run_book_merging, 6)
    except Exception:
        pass

    return "", 202


if __name__ == "__main__":
    PORT = os.environ.get("PORT", 5000)
    app.run(port=PORT)
