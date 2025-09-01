import base64
import binascii
import io
import os
from werkzeug.utils import secure_filename
from flask import Flask, request, send_from_directory, abort, send_file, render_template
from flask_cors import CORS
import math
from urllib.parse import unquote
from typing import List
from datetime import datetime
import json
import mkepub
import requests, PIL
import re
from natsort import natsorted

url_turbo_regex = r"^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)$"
image_data_url_regexp = re.compile(r"^data:(image/[\w.+-]+)?;base64,(.*)$", re.IGNORECASE | re.DOTALL)

class NovelMetadata:
    author:str
    collection:List[mkepub.BookCollectionMetadata]
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

app = Flask(__name__)
CORS(app)

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')


@app.route('/', methods=["GET", "HEAD"], defaults={'req_path': ''})
@app.route('/<path:req_path>')
def dir_listing(req_path):
    BASE_DIR = 'C:/Users/guyma/Desktop/epub-downloader/result'

    # Joining the base and the requested path
    abs_path = os.path.join(BASE_DIR, unquote(req_path))

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

    for image in images:
        if image.content_type != "image/png":
            return abort(406)
        
    chapterContentFileStream = chapterContentFile.stream
    chapterContent = chapterContentFileStream.read().decode()
    chapterContentFileStream.close()
    
    metadataFileStream = metadataFile.stream
    metadataContent = metadataFileStream.read()
    metadataFileStream.close()

    try:
        metadata : mkepub.BookMetadata = json.loads(metadataContent)
    except:
        return abort(406)

    epubVolume = mkepub.Book(**metadata)

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
        print(f"adding image {image.filename}")
        epubVolume.add_image(image.filename, imageContent)
    
    file_location = f"./result/{secure_filename(metadata['collections'][0]['name'])}/{secure_filename(metadata['volumeName'])}"
    file_path = f"{file_location}/{metadata['title']}.epub"

    os.makedirs(file_location, exist_ok=True)
    print(f"Saving epub file")
    epubVolume.save(filename=file_path)

    return "", 202

app.run()
