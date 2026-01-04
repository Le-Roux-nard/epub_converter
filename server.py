import base64
import binascii
import io
import os
from werkzeug.utils import secure_filename
from flask import Flask, request, send_from_directory, abort, send_file, render_template
from flask_cors import CORS
import math
from urllib.parse import unquote
from typing import List, Callable
from datetime import datetime
import json
from mkepub import Book, BookMetadata, BookCollectionMetadata
import requests, PIL
import threading
import re
from natsort import natsorted
from dotenv import load_dotenv

dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path)

url_turbo_regex = r"^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)$"
image_data_url_regexp = re.compile(r"^data:(image/[\w.+-]+)?;base64,(.*)$", re.IGNORECASE | re.DOTALL)

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
        raise ValueError("Format data URL invalide. Attendu: data:image/<type>;base64,<...>")

    b64_part = m.group(2)
    try:
        return base64.b64decode(b64_part, validate=True)
    except binascii.Error as e:
        raise ValueError(f"Contenu base64 invalide: {e}")

_debounce_lock = threading.Lock()
_debounce_timers: dict = {}

def debounce_execution(dir_path: str, callback: Callable[[list], None], delay: float = 5.0 ):
    """Planifie une lecture (listing) du dossier `dir_path` après `delay` secondes d'inactivité.

    Si la fonction est rappelée avant la fin du délai, l'exécution est repoussée (debounce).
    `callback` est optionnel et reçoit la liste des fichiers au moment de l'exécution.
    """
    dir_path = os.path.abspath(dir_path)

    with _debounce_lock:
        existing = _debounce_timers.get(dir_path)
        if existing is not None:
            try:
                existing.cancel()
            except Exception:
                pass

        timer = threading.Timer(interval=delay, function=callback, args=[dir_path])
        timer.daemon = True
        _debounce_timers[dir_path] = timer
        timer.start()

def _run_directory_listing(dir_path: str):
    """Fonction appelée par le Timer pour lister le dossier et appeler le callback (si fourni)."""
    try:
        nodes = os.listdir(dir_path)
    except Exception:
        nodes = []

    nodes.sort(key=lambda a: int(re.findall(r"(?<=Chapitre )(\d+)", a)[0]) if re.findall(r"(?<=Chapitre )(\d+)", a) else 0)

    files = list(map(lambda node: os.path.join(dir_path, node), nodes))

    books : List[Book]= []
    for file in files:
        if os.path.isfile(file) and file.lower().endswith(".epub"):
            book = Book.read(file)
            books.append(book)

    folder_name = re.split(r"\\|\/", dir_path)[-1]
    book_title = folder_name if folder_name not in ["Chapitres", "Volumes"] else books[0].metadata["collections"][0]["name"] if len(books) > 0 and "collections" in books[0].metadata and len(books[0].metadata["collections"]) > 0 else re.split(r"\\|\/", dir_path)[-2]

    merged_metadata : BookMetadata = {
        "title": book_title,
        "collections": books[0].metadata["collections"] if len(books) > 0 and "collections" in books[0].metadata else [],
        "creators": [dict(t) for t in list({ tuple(sorted(creator.items())) for book in books for creator in book.metadata["creators"] })],
        "contributors": [dict(t) for t in list({ tuple(sorted(contributor.items())) for book in books for contributor in book.metadata["contributors"] })],
        "description": "\n\n".join(set([book.metadata["description"] for book in books if "description" in book.metadata])),
        "lang": books[0].metadata["lang"] if len(books) > 0 and "lang" in books[0].metadata else "en",
        "rights": books[0].metadata["rights"] if len(books) > 0 and "rights" in books[0].metadata else "",
        "subjects": list(set([subject for book in books for subject in book.metadata.get("subjects", [])]))
    }

    novel_folder = os.path.join(dir_path, "..")

    merge_result = Book.merge(merged_metadata, *books)

    merge_result.set_cover(books[0].get_cover())

    filename = os.path.join(novel_folder, f"{merged_metadata['title']}.epub")
    if os.path.exists(filename):
        try:
            os.unlink(filename)
        except Exception:
            pass
    merge_result.save(filename=os.path.join(novel_folder, f"{merged_metadata['title']}.epub"), with_visible_toc=True, with_cover_as_first_page=True)


# ------------------------------------------

app = Flask(__name__)
CORS(app)

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')


@app.route('/', methods=["GET", "HEAD"], defaults={'req_path': ''})
@app.route('/<path:req_path>')
def dir_listing(req_path):

    # Joining the base and the requested path
    EPUB_ROOT_FOLDER = os.environ.get("EPUB_ROOT_FOLDER", "./results/")
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


    return render_template('index.html',previous_dir=previous_dir, actual_dir=req_path, files=natsorted(files, key=lambda f: f["name"]))


@app.post('/')
def buildEpub():
    files = list(request.files.values())

    htmlFiles = list(filter(lambda f: f.filename == "chapter.html", files))
    jsonFiles = list(filter(lambda f: f.filename == "metadata.json", files))
    images = list(filter(lambda f: f.filename.endswith(".png"), files))

    
    if len(htmlFiles) != 1 or len(jsonFiles) != 1:
        return "Can't process files without exactly one 'chapter.html' and one 'metadata.json'",422

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
        metadata : BookMetadata = json.loads(metadataContent)
    except:
        return abort(406)

    epubVolume = Book(**metadata)

    if re.match(url_turbo_regex, metadata["cover"]):
        cover_content = requests.get(metadata["cover"]).content
        PIL.Image.open(io.BytesIO(cover_content)).verify()
        epubVolume.set_cover(cover_content)
    elif re.match(image_data_url_regexp, metadata["cover"]):
        epubVolume.set_cover(decode_data_url_to_bytes(metadata["cover"]))
    else:
        epubVolume.generate_cover()

    epubVolume.add_page(metadata["title"], chapterContent)
    for imageFile in images:
        imageFileStream = imageFile.stream
        imageContent = imageFileStream.read()
        imageFileStream.close()
        epubVolume.add_image(imageFile.filename, imageContent)
    
    EPUB_ROOT_FOLDER = os.environ.get("EPUB_ROOT_FOLDER", "./results/")

    file_location = [EPUB_ROOT_FOLDER]
    if 'collections' in metadata and len(metadata['collections']) > 0:
        file_location.append(secure_filename(metadata['collections'][0]['name']))
    
    if 'volumeName' in metadata:
        file_location.append(secure_filename(metadata['volumeName']))

    final_dir = os.path.join(*file_location)
    os.makedirs(final_dir, exist_ok=True)
    file_path = os.path.join(final_dir, f"{metadata['title']}.epub")

    epubVolume.save(filename=file_path, with_visible_toc=False, with_cover_as_first_page=False)

    # Planifie un listing debounced pour n'exécuter la lecture du dossier qu'une seule fois
    try:
        debounce_execution(final_dir, _run_directory_listing, 60)
    except Exception:
        pass

    return "", 202


if __name__ == "__main__":
    PORT = os.environ.get("PORT", 5000)
    app.run(port=PORT)
