import base64
import binascii
import io
import os
import json
import requests
import threading
import re
import math
import copy
from werkzeug.utils import secure_filename
from flask import Flask, request, send_from_directory, abort, send_file, render_template
from flask_cors import CORS
from urllib.parse import quote, unquote
from typing import List, Callable
from datetime import datetime
from mkepub import Book, BookMetadata, BookCollectionMetadata, ContributorMetadata
from natsort import natsorted
from dotenv import load_dotenv
from PIL import Image
from pathlib import Path
from bs4 import BeautifulSoup

dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(dotenv_path)

url_turbo_regex = r"^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)$"
image_data_url_regexp = re.compile(
    r"^data:(image/[\w.+-]+)?;base64,(.*)$", re.IGNORECASE | re.DOTALL)

EPUB_ROOT_FOLDER = Path(os.environ.get("EPUB_ROOT_FOLDER", "./results/"))
locks = {}
line_break_style = """
p {
    margin: 13px 0;
    /* display:block; */
}

body, div, img {
    padding: 0pt;
    margin: 0pt;
    line-height: 125%;
}

body {
    text-align: left;
}

.line-break {
    display: block;
    width: 100%;
    height: 1em;
    position:relative
}

.line-break::after {
    position: absolute;
    font-style:italic;
    content: "* * *";
    left: 50%;
    transform: translateX(-75%);
}


img {
display: block;
margin-left: auto;
margin-right: auto;
margin-bottom: 1em;
max-width: 75%;
max-height: 80%;
object-fit: contain;
}
"""


class NovelMetadata:
    creators: List[ContributorMetadata]
    contributors: List[ContributorMetadata]
    collection: List[BookCollectionMetadata]
    subjects: str
    description: str
    cover: str
    volumeName: str


class DumpRequestMetadata:
    creators: List[ContributorMetadata]
    contributors: List[ContributorMetadata]
    collection: List[BookCollectionMetadata]
    subjects: str
    description: str
    cover: str
    volumeName: str
    chapters: List[str]


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
        "description": "\n\n".join(set([book.metadata["description"] for book in books if "description" in book.metadata and book.metadata["description"] is not None])),
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


def dumpEpubFromVolumeMetadata(novelName: str, volumeName: str, metadata: NovelMetadata, target_folder: Path):
    global locks
    try:
        series_zfill = {}
        thread_session = requests.Session()
        thread_session.max_redirects = 5
        thread_session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0",
            "Referer": "https://world-novel.fr/"
        })
        for collection in metadata["collections"]:
            series_zfill[collection["name"]] = int(
                len(str(len(metadata["chapters"]))))

        cover_content = None
        if re.match(url_turbo_regex, metadata["cover"]):
            cover_content = thread_session.get(metadata["cover"]).content
        elif re.match(image_data_url_regexp, metadata["cover"]):
            cover_content = decode_data_url_to_bytes(metadata["cover"])

        # Convert cover to PNG as not all EPUB readers support other formats like WEBP even though EPUB standard allows it
        if cover_content is not None:
            cover_bytes = io.BytesIO(cover_content)
            im = Image.open(cover_bytes)
            new_cover = io.BytesIO()
            im.convert("RGB").save(new_cover, format="PNG")
            cover_content = new_cover.getvalue()

        root_url = f"https://cdn.world-novel.fr/chapitres/?userId=dEVJy3lAr5O3r3AQ0JSjraRMXvC3"

        for (chapter_index, chapter_url) in enumerate(metadata["chapters"]):
            chapter_metadata = copy.deepcopy(metadata)
            chapter_metadata.pop("chapters", None)
            chapter_metadata.pop("volumeName", None)
            chapter_metadata["title"] = unquote(
                chapter_url.split("/")[-1]).strip()

            chapter_obfuscated_html = thread_session.get(f"{root_url}&path={chapter_url}", headers={
                "Origin": "https://world-novel.fr",
                "X-Firebase-AppCheck": "eyJraWQiOiJ2ckU4dWciLCJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxOjYxMTA4Nzk4MzcwOndlYjo2N2E2MDYwOTQ0YjRlYWY4ZWIyOGZiIiwiYXVkIjpbInByb2plY3RzLzYxMTA4Nzk4MzcwIiwicHJvamVjdHMvdmljdG9yaWFuLW5vdmVsLWhvdXNlIl0sInByb3ZpZGVyIjoicmVjYXB0Y2hhX3YzIiwiaXNzIjoiaHR0cHM6Ly9maXJlYmFzZWFwcGNoZWNrLmdvb2dsZWFwaXMuY29tLzYxMTA4Nzk4MzcwIiwiZXhwIjoxNzY5Mjc4NTA4LCJpYXQiOjE3Njg2NzM3MDgsImp0aSI6ImY1OE5KVnFyMzhDR1F0TnVYTW8tWENXQUZnUG9BUnRLUlFjdlVMNll6eDQifQ.Mf8IUGoAiTjF5PgOvi14-hykhBVfHzCk7lPNCWuW7Y10CYrPA88KHp6c0aVsg7GygJx0rXDLCTr3lpM7Gqbu6iF_yAWa0vHJc7pjUPmSol_Xe8swP5WgMDDCIUbL339tLIzbGdu6mZeWI7p2XPqsZ13_WiSHX3QpGhYjivT-Z84YICZAhubzgM-bRj5cTYnf1dmtU43vdRsR1-6p1saiaGaep_sZQXpJcDPaaienqvfZ7uG34-Gsjk6nngbQ_m7V5jU_G3HhqIv854w4jTZ6oYVn8MLTmbTOtcB31P9zaEE_XDNco9aJcdVb_aEclDxVrFQ5sCr3wJHjtnscgE3VZgtBBNKHFMxzBByJoGfi99MB28oGrQ6tzgNVD0NI_laezvX0zpkDCeE_ApHZOIzHRFlbK6YQm3xKlb7DVAKYL0DeabxNMq1SDMDx_DHQyyTqSLq0Jy3XZOpBZ8TKqyr8K4SCCLEswHOBCz0MeXKx5sGlQHDfxbLpzPjGev-cKaxr"
            }, timeout=60).content.decode()

            soup = BeautifulSoup(chapter_obfuscated_html,
                                 "html.parser")  # ou "html.parser"
            html_link_node = soup.find("link", {"rel": "stylesheet"})
            if not html_link_node or "href" not in html_link_node.attrs:
                raise Exception(
                    f"Impossible de trouver le lien CSS dans le HTML pour {chapter_url}")
            css_url = html_link_node["href"]

            css_content = thread_session.get(css_url).content.decode()
            obfuscating_classes = re.findall(
                r'(?<=\.).{8}(?={.+;})', css_content)
            obfuscating_classes_selector = list(
                map(lambda c: f"span[class='{c}']", obfuscating_classes))

            if len(obfuscating_classes_selector) == 0:
                raise Exception(
                    f"Impossible de trouver les classes d'obfuscation dans le CSS pour {unquote(chapter_url)}")

            for s in soup.select(",".join(obfuscating_classes_selector)):
                s.decompose()

            for img in soup.find_all("img"):
                src = img.get("src")
                if src and re.match(url_turbo_regex, src):
                    im_data = thread_session.get(src).content
                    im_bytes = io.BytesIO(im_data)
                    im = Image.open(im_bytes)
                    im.verify()

                    png_im = io.BytesIO()
                    im.convert("RGB").save(png_im, format="PNG")
                    b64_encoded_im = base64.b64encode(
                        png_im.getvalue()).decode("utf-8")
                    dataURL_im = f"data:image/png;base64,{b64_encoded_im}"
                    img.attrs['src'] = dataURL_im

            deobfuscated_html = soup.select_one("div").decode_contents()
            cleaned_chapter_html = re.sub(
                r'<span class=".{8}">(.+?)<\/span>', r'\g<1>', deobfuscated_html)

            chapter_number = int(re.findall(r"(?<=Chapitre )(\d+)", chapter_metadata["title"])[0]) if re.findall(r"(?<=Chapitre )(\d+)", chapter_metadata["title"]) else 0
            for collection in chapter_metadata["collections"]:
                collection_index = str(chapter_number).zfill(series_zfill[collection["name"]])
                collection["number"] = f"{collection['number']}.{collection_index}"

            epubChapter = Book(**chapter_metadata)
            epubChapter.set_cover(cover_content)
            epubChapter.add_stylesheet(data=line_break_style)
            epubChapter.add_page(
                chapter_metadata["title"], cleaned_chapter_html)
            file_path = target_folder / f"{chapter_metadata['title']}.epub"
            if os.path.exists(file_path) is False:
                epubChapter.save(filename=file_path.resolve(
                ), with_visible_toc=False, with_cover_as_first_page=False)
        print("Finished downloading volume:", novelName, volumeName)
        _run_book_merging(target_folder)
    except Exception as err:
        print(f"An exception occured while dumping {novelName} / {volumeName}", err)
    finally:
        print("Releasing lock for:", novelName, volumeName)
        locks.pop(f"{novelName}/{volumeName}", None)

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


@app.post('/<path:novel_name>/<path:volume_name>')
def requestNovelDump(novel_name: str, volume_name: str):
    global locks
    metadata: DumpRequestMetadata = request.get_json(force=True)

    if not metadata:
        return abort(406)

    if f"{novel_name}/{volume_name}" in locks:
        return "", 423  # Processing
    else:
        locks[f"{novel_name}/{volume_name}"] = True

    target_folder = EPUB_ROOT_FOLDER / novel_name / volume_name

    os.makedirs(target_folder, exist_ok=True)

    missing_chapters_list: List[str] = []
    for chapter in metadata["chapters"]:
        exploded_chapter = chapter.split("/")
        # Sanitize path by removing slashes and dots
        exploded_chapter[-1] = re.sub(
            r'\/|(?<=[^.])\.{2}(?=[^.])|\.{4,}', '', exploded_chapter[-1])

        file_path = target_folder / f"{exploded_chapter[-1].strip()}.epub"
        if file_path.exists():
            continue
        else:
            exploded_chapter[-1] = quote(exploded_chapter[-1])
            missing_chapters_list.append("/".join(exploded_chapter))

    status = 500
    if (len(missing_chapters_list) == 0):
        return missing_chapters_list, 208  # Already Reported
    elif len(missing_chapters_list) == len(metadata["chapters"]):
        status = 202  # Accepted
    else:
        status = 206  # Partial Content

    metadata["chapters"] = missing_chapters_list

    threading.Thread(target=dumpEpubFromVolumeMetadata, args=(
        novel_name, volume_name, metadata, target_folder)).start()

    return missing_chapters_list, status


if __name__ == "__main__":
    PORT = os.environ.get("PORT", 5000)
    app.run(port=PORT)
