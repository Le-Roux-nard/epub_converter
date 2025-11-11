// ==UserScript==
// @name         Dump Chapters
// @namespace    http://tampermonkey.net/
// @version      2025-07-29
// @description  try to take over the world!
// @author       You
// @match        https://victorian-novel-house.fr/lecture/*/volumes/*/chapitres/*
// @match        https://victorian-novel-house.fr/oeuvres/*
// @match        https://world-novel.fr/lecture/*/volumes/*/chapitres/*
// @match        https://world-novel.fr/oeuvres/*
// @match        https://cdn.victorian-novel-house.fr/images/*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=victorian-novel-house.fr
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// @grant        GM.removeValues
// ==/UserScript==

const corsBypassProxy = 'https://fuck-cors.lerouxnard.workers.dev'
const backupServerURL = 'https://fuck-victorian-novel-house.lerouxnard.fr/'

const lineBreakStyle = `
<style>
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
</style>
`

function wait (time) {
  return new Promise(res => setTimeout(res, time))
}

function waitForElement (selector, timeout = 10_000) {
  return new Promise((res, rej) => {
    const observer = new MutationObserver((mutations, observer) => {
      const element = document.querySelector(selector)
      if (element) {
        observer.disconnect()
        res()
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true
    })

    setTimeout(() => {
      observer.disconnect()
      rej()
    }, timeout)
  })
}

function waitForChapterLoad (selector) {
  return new Promise(res => {
    const observer = new MutationObserver(() => {
      observer.disconnect()
      res()
    })

    // call `observe()`, passing it the element to observe, and the options object
    observer.observe(document.querySelector(selector), {
      subtree: true,
      characterData: true
    })

    observer.observe(document.querySelector(selector), {
      subtree: true,
      childList: true
    })
  })
}

function waitForTabToBeClosed (tab) {
  return new Promise(res =>
    setInterval(() => {
      if (tab.closed) res()
    }, 500)
  )
}

async function loadCSSCors (stylesheet_uri) {
  return new Promise(res => {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', stylesheet_uri)
    xhr.onload = function () {
      xhr.onload = xhr.onerror = null
      if (xhr.status < 200 || xhr.status >= 300) {
        alert('style failed to load: ' + stylesheet_uri)
      } else {
        var style_tag = document.createElement('style')
        style_tag.appendChild(document.createTextNode(xhr.responseText))
        document.head.appendChild(style_tag)
        res()
      }
    }
    xhr.onerror = function () {
      xhr.onload = xhr.onerror = null
      alert('XHR CORS CSS fail:' + stylesheet_uri)
    }
    xhr.send()
  })
}

async function waitForLocalStorage (key, interval = 100) {
  return new Promise(res => {
    let checker = setInterval(async () => {
      const keys = await GM.listValues()
      if (keys.includes(key)) {
        clearInterval(checker)
        const value = GM.getValue(key)
        GM.deleteValue(key)
        return res(value)
      }
    }, interval)
  })
}

function openInNewTab (url) {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.referrerPolicy = 'no-referrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

//**blob to dataURL**
async function blobToDataURL (blob) {
  return new Promise(res => {
    var a = new FileReader()
    a.onload = e => res(e.target.result)
    a.readAsDataURL(blob)
  })
}

async function getImageData (
  url,
  options = { headers: { referer: document.location.origin } }
) {
  const imageData = await fetch(url, options)
  const blobifiedImage = await imageData.blob() // stored in the browser cache
  const blobUrl = URL.createObjectURL(blobifiedImage)
  return blobUrl
}

async function fuckCorsAndGetBypassURL (pictureUrl) {
  return `${corsBypassProxy}/?keepReferer=true&url=${pictureUrl}`
}

async function getNovelMetadata () {
  const novelTitleNode = document.querySelector('h2')
  const synopsisParagraph = document.querySelector('section > div > div > p')
  const authorSpan = document.querySelector('section > div span:nth-child(1)')
  const translatorSpan = document.querySelector(
    'section > div span:nth-child(2)'
  )
  const coverElement = document.querySelector('section div img')
  //const coverDataURL = await getImageData(coverElement.src);
  const coverBlobUrl = await getImageData(
    fuckCorsAndGetBypassURL(coverElement.src)
  )

  return [
    {
      author: authorSpan.innerText.split(':').at(-1).trim(),
      collection: {
        id: window.location.pathname.split('/').at(-1),
        name: novelTitleNode.innerText
      },
      translator: translatorSpan.innerText.split(':').at(-1).trim(),
      synopsys: synopsisParagraph.innerText
    },
    coverBlobUrl
  ]
}

async function getVolumeMetada (novelMetadata, volumeName) {
  let volumeNumber
  try {
    ;[volumeName, volumeNumber] = /(?<=(\d+) - ).+|^.+ (\d+)$/
      .exec(volumeName)
      .filter(value => !!value) ?? [volumeName, 0]
  } catch {
    volumeNumber = 0
  }

  // const getApiBookSearchURL = (author, novelName, bookName) => `https://www.googleapis.com/books/v1/volumes?q=inauthor:${author},intitle:${encodeURIComponent(novelName)},intitle:${encodeURIComponent(bookName)}`;
  const getApiBookSearchURL = (author, novelName, bookName) =>
    `https://www.googleapis.com/books/v1/volumes?q=${author},${encodeURIComponent(
      novelName
    )},${encodeURIComponent(bookName)}`

  const verifyResultsItemsFunction = (item, bookName) =>
    item.volumeInfo.title.includes(bookName) ||
    item.volumeInfo?.subtitle?.includes(bookName)

  const novelCollection = JSON.parse(JSON.stringify(novelMetadata.collection))
  novelCollection.number = volumeNumber

  let bookSearchResults
  let availableTitleVariation = [
    volumeName,
    `Vol ${volumeNumber}`,
    `Vol. ${volumeNumber}`,
    `Book ${volumeNumber}`
  ]

  bookSearchResults = await fetch(
    getApiBookSearchURL(
      novelMetadata.author,
      novelMetadata.collection.name,
      volumeName
    )
  ).then(r => r.json())

  if (bookSearchResults.totalItems === 0) {
    //No match found
    return {
      ...novelMetadata,
      collection: novelCollection,
      volumeName: volumeName
    }
  } else {
    let validBook
    for (const variation of availableTitleVariation) {
      validBook = bookSearchResults.items.find(i =>
        verifyResultsItemsFunction(i, variation)
      )
      if (!!validBook) break
    }
    if (!validBook) {
      return {
        ...novelMetadata,
        collection: novelCollection,
        volumeName: volumeName
      }
    }
    let bookName = `${validBook.volumeInfo.title} ${
      validBook.volumeInfo.subtitle ?? ''
    }`

    availableTitleVariation.shift() // remove the book title from the loop to avoid it being replaced

    for (const variation of availableTitleVariation) {
      bookName = bookName.replace(variation, '')
    }

    bookName = bookName
      .replace(novelMetadata.collection.name, '')
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      .trim()

    if (bookName == '') {
      bookName = validBook.volumeInfo.title
    }

    let volumeCover
    if (!!validBook.volumeInfo?.imageLinks?.thumbnail) {
      volumeCover = `https://books.google.com/books/publisher/content/images/frontcover/${validBook.id}?fife=w10000`
    }

    return {
      ...novelMetadata,
      collection: novelCollection,
      volumeName: volumeName,
      synopsys: validBook.volumeInfo.description,
      cover: volumeCover ?? novelMetadata.cover
    }
  }
}

async function checkIfExportAlreadyExists (volumeMetadata, chapterName) {
  const collectionName = volumeMetadata.collection.name.replace(
    /[^A-Za-z0-9]/g,
    '_'
  )
  const volumeName = volumeMetadata.volumeName.replace(/[^A-Za-z0-9]/g, '_')
  const url = `${backupServerURL}/${collectionName}/${volumeName}/${chapterName}.epub`

  return await new Promise(async fullfill => {
    let xhr = new XMLHttpRequest()
    xhr.open('HEAD', url)
    xhr.onload = function () {
      fullfill(xhr.status == 302)
    }
    xhr.send()
  })
}

if (window.top != window.self) {
  //don't run on frames or iframes
  return
}

/* ------------ Debug overlay (affichée sur la page, sans alertes additionnelles) ------------- */
function createDebugOverlay () {
  try {
    const existing = document.getElementById('dumpchapters-debug-overlay')
    if (existing) return existing

    const container = document.createElement('div')
    container.id = 'dumpchapters-debug-overlay'
    container.style.position = 'fixed'
    container.style.right = '12px'
    container.style.bottom = '12px'
    container.style.zIndex = '2147483647'
    container.style.maxWidth = '420px'
    container.style.maxHeight = '50vh'
    container.style.overflow = 'auto'
    container.style.background = 'rgba(0,0,0,0.75)'
    container.style.color = 'white'
    container.style.fontSize = '12px'
    container.style.lineHeight = '1.4'
    container.style.padding = '8px'
    container.style.borderRadius = '6px'
    container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.6)'
    container.style.fontFamily = 'Arial, Helvetica, sans-serif'

    const title = document.createElement('div')
    title.innerText = 'DumpChapters - debug'
    title.style.fontWeight = '700'
    title.style.marginBottom = '6px'

    const clearBtn = document.createElement('button')
    clearBtn.innerText = 'Effacer'
    clearBtn.style.marginRight = '6px'
    clearBtn.onclick = () => {
      logArea.innerText = ''
    }

    const closeBtn = document.createElement('button')
    closeBtn.innerText = 'Fermer'
    closeBtn.onclick = () => container.remove()

    const controls = document.createElement('div')
    controls.style.marginBottom = '6px'
    controls.appendChild(clearBtn)
    controls.appendChild(closeBtn)

    const logArea = document.createElement('div')
    logArea.id = 'dumpchapters-log'
    logArea.style.whiteSpace = 'pre-wrap'

    container.appendChild(title)
    container.appendChild(controls)
    container.appendChild(logArea)
    document.body.appendChild(container)

    return container
  } catch (e) {
    return null
  }
}

const debugOverlay = createDebugOverlay()

function debugLog (msg, level = 'info') {
  const time = new Date().toLocaleTimeString()
  const full = `[${time}] ${level.toUpperCase()} - ${msg}`
  if (debugOverlay) {
    const area = debugOverlay.querySelector('#dumpchapters-log')
    if (area) {
      area.innerText += full + '\n'
      debugOverlay.scrollTop = debugOverlay.scrollHeight
    }
  }
  try {
    console.log(full)
  } catch (e) {}
}
/* ------------------------------------------------------------------------------------------ */

;(async function () {
  'use strict'

  const params = window.location.search
  const pathname = document.location.pathname

  if (!params.includes('debug=true')) {
    debugOverlay.remove()
  }

  debugLog('script démarré, pathname: ' + pathname)

  if (pathname.match(/\/images\/.+?\/.+/)) {
    debugLog('gestion image: page /images/ détectée')
    //#region Gestion des Images
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = document.querySelector('img')

    canvas.width = img.width
    canvas.height = img.height

    ctx.drawImage(img, 0, 0, img.width, img.height)

    const localStorageKey = pathname.split('/').at(-1)
    await GM.setValue(localStorageKey, canvas.toDataURL('image/png'))
    debugLog('image stockée en GM avec clé ' + localStorageKey)
    // return window.close();
    //#endregion
  }

  if (pathname.match(/\/oeuvres\/([a-z\-0-9]+)/)) {
    debugLog('page oeuvre détectée')
    //#region Oeuvre

    //unfold all volumes to load chapters in the DOM
    await waitForElement('div > h3')
    const volumes = [...document.querySelectorAll('div > h3')]
    const [novelMetadata, coverBlobUrl] = await getNovelMetadata()
    console.log(novelMetadata, coverBlobUrl)
    try {
      await window.localStorage.setItem(
        `${novelMetadata.collection.id}`,
        JSON.stringify({ ...novelMetadata, cover: coverBlobUrl })
      )
    } catch (e) {
      debugLog('localStorage set pour metadata impossible: ' + e, 'warn')
    }

    volumes.reverse()

    const localVolumesMetadata = {}
    for await (const volume of volumes) {
      const volumeMetadata = await getVolumeMetada(
        novelMetadata,
        volume.innerText
      )
      localVolumesMetadata[volume.innerText] = volumeMetadata
      try {
        window.localStorage.setItem(
          `${volumeMetadata.collection.id}-${volumeMetadata.collection.number}`,
          JSON.stringify(volumeMetadata)
        )
      } catch (e) {
        debugLog('localStorage set pour volume impossible: ' + e, 'warn')
      }
    }

    if (!params.includes('dump=true')) {
      debugLog('dump=true absent sur page oeuvre -> arrêt')
      return
    }

    for await (const volume of volumes) {
      volume.click()
      let volumeMetadata = localVolumesMetadata[volume.innerText]
      await waitForElement('div > ul a')
      const chapters = [...volume.nextSibling.querySelectorAll('a')]
      for await (const chapter of chapters.reverse()) {
        const chapterSlug = decodeURIComponent(chapter.href.split('/').at(-1))
        debugLog('vérification export existant pour ' + chapterSlug)
        const shouldSkip = await checkIfExportAlreadyExists(
          volumeMetadata,
          chapterSlug
        )
        if (shouldSkip) {
          debugLog('skip (existe déjà) : ' + chapterSlug)
          continue
        }
        let tab = window.open(`${chapter.href}?dump=true&close=true`, '_blank')
        if (!tab) {
          debugLog('échec ouverture onglet (popup bloquée?)', 'error')
          return
        }
        await waitForTabToBeClosed(tab)
      }
      volume.click()
    }

    return
    //#endregion
  } else if (
    pathname.match(/\/lecture\/(['a-z\-0-9]+)\/volumes\/.+\/chapitres\/(.+)/)
  ) {
    debugLog('page chapitre détectée')
    if (!params.includes('dump=true')) {
      debugLog('dump=true absent sur page chapitre -> arrêt')
      return
    }

    //#region Chapitre
    const chapterContentLocator = '#textContainer > .chapter-obf'

    try {
      await waitForElement(chapterContentLocator, 1_000)
    } catch {
      const buttons = [...document.querySelectorAll('button')]
      const loadchapterButton = buttons.find(
        b => b.innerText == 'Charger le chapitre'
      )
      if (!!loadchapterButton) {
        loadchapterButton.click()
      }
      await waitForElement(chapterContentLocator)
    }

    try {
      const cssSheet = [
        ...document.querySelectorAll('link[rel=stylesheet]')
      ].find(s => s.href.includes('chapitre'))
      await loadCSSCors(cssSheet.href)

      for (const styleSheet of document.styleSheets) {
        try {
          for (const rule of styleSheet.cssRules) {
            if (!!rule && !!rule.style && rule.style['font-size'] === '0px') {
              document
                .querySelectorAll(rule.selectorText)
                .forEach(e => e.remove())
            }
          }
        } catch (err) {}
      }

      const chapterContainer = document.querySelector(chapterContentLocator)
      let chapterContent = chapterContainer.innerHTML

      chapterContent = chapterContent.replace(
        /<span class=".{8}">|<\/span>/g,
        ''
      ) //purge annoying span used to specify spacing between letters and insert dummy letters in a try to prevent chapter dumping (useless af)
      chapterContent = chapterContent.replace(/(?:<br\s*\/*>)+/, '\n')

      //form initialisation
      const formData = new FormData()
      let i = 0
      const chapterImages = []
      for await (const image of [...chapterContainer.querySelectorAll('img')]) {
        let imageName = decodeURI(image.src.split('/').at(-1))
        if (imageName in chapterImages)
          return alert('Image name already used ! something might be wrong')
        const imageBlob = await fetch(fuckCorsAndGetBypassURL(image.src), {
          headers: { referer: document.location.origin }
        }).then(r => r.blob())

        const file = new File([imageBlob], imageName, { type: imageBlob.type })
        chapterContent = chapterContent.replace(
          image.src,
          `images/${imageName}`
        )
        chapterImages.push(imageName)
        formData.append(`files[${i}]`, file)
      }

      chapterContent = `${lineBreakStyle}\n${chapterContent}` //ajout de la feuille de style custom en premier

      const uint8ArrayChapterContent = new TextEncoder().encode(chapterContent)
      const chapterContentBlob = new Blob([uint8ArrayChapterContent], {
        type: 'text/html'
      })
      const chapterFile = new File([chapterContentBlob], `chapter.html`, {
        type: 'text/html'
      })

      i += 1 // incrémente pour intégrer le chapitre

      formData.append(`files[${i}]`, chapterFile)

      const novelName = document
        .querySelector('main div div a:nth-child(2)')
        .innerText.toLowerCase()
        .replace(/[^'a-z]/g, '-')

      const chapterName = document.querySelector(
        'main div div span:nth-of-type(2)'
      ).innerText
      const volumeNumber = document
        .querySelector('main div div span')
        .innerText.replace(/[^0-9]/g, '')
      const localStorageMetadata = JSON.parse(
        await window.localStorage.getItem(
          `${novelName}-${volumeNumber ? volumeNumber : '0'}`
        )
      )
      if (!localStorageMetadata)
        return alert(
          "Impossible d'extraire ce chapitre, merci de charger la page de l'oeuvre dans un premier temps"
        )

      if (!localStorageMetadata.cover) {
        const novelMetadata = JSON.parse(window.localStorage.getItem(novelName))
        localStorageMetadata.cover = await fetch(novelMetadata.cover)
          .then(r => r.blob())
          .then(blobToDataURL) //cover is given as base64 property in body request
        //TODO: think about passing cover by files like other images
      }

      const metadata = {
        title: chapterName,
        lang: 'fr',
        collections: [
          {
            ...localStorageMetadata.collection,
            type: 'series'
          }
        ],
        creators: [
          {
            name: localStorageMetadata.author,
            role: 'aut'
          }
        ],
        contributors: [
          {
            name: localStorageMetadata.translator,
            role: 'trl'
          }
        ],
        subjects: [],
        description: localStorageMetadata.synopsys,
        cover: localStorageMetadata.cover,
        volumeName: localStorageMetadata.volumeName
      }

      debugLog(JSON.stringify(metadata, null, 4))
      const uint8ArrayMetadata = new TextEncoder().encode(
        JSON.stringify(metadata, null, 4)
      )
      const metadataBlob = new Blob([uint8ArrayMetadata], {
        type: 'application/json'
      })
      const metadataFile = new File([metadataBlob], `metadata.json`, {
        type: 'application/json'
      })
      i += 1 // incrémente pour intégrer les métadonnées du chapitre

      formData.append(`files[${i}]`, metadataFile)

      try {
        await fetch(backupServerURL, {
          method: 'POST',
          body: formData
        })
        debugLog('chapitre envoyé au backupServer')
      } catch (error) {
        console.error("❌ Erreur lors de l'envoi :", error)
        debugLog(
          'erreur envoi: ' + (error && error.message ? error.message : error),
          'error'
        )
      }

      if (params.includes('close=true')) {
        return window.close()
      }
    } catch (err) {
      alert(err)
    }
    //#endregion
  }
})()
