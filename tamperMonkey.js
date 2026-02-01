// ==UserScript==
// @name         Dump Chapters 2.0
// @namespace    http://tampermonkey.net/
// @version      2025-07-29
// @description  try to take over the world!
// @author       You
// @match        https://world-novel.fr/oeuvres/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=victorian-novel-house.fr
// @downloadURL  https://github.com/Le-Roux-nard/epub_converter/raw/refs/heads/master/tamperMonkey.js
// @updateURL    https://github.com/Le-Roux-nard/epub_converter/raw/refs/heads/master/tamperMonkey.js
// @run-at context-menu
// ==/UserScript==

const corsBypassProxy = 'https://fuck-cors.lerouxnard.workers.dev'
const backupServerURL = 'https://fuck-victorian-novel-house.lerouxnard.fr/'

function waitForElement (selector, timeout = 10_000) {
  let e = document.querySelector(selector)
  if (!!e) return e

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

async function getNovelMetadata () {
  const novelTitleNode = document.querySelector('h2')
  const synopsisParagraph = document.querySelector('section > div > div > p')
  const authorSpan = document.querySelector('section > div span:nth-child(1)')
  const translatorSpan = document.querySelector(
    'section > div span:nth-child(2)'
  )
  const coverElement = document.querySelector('section div img')

  return {
      title: novelTitleNode.innerText,
      author: authorSpan.innerText.split(':').at(-1).trim(),
      collection: {
        id: window.location.pathname.split('/').at(-1),
        name: novelTitleNode.innerText
      },
      translator: translatorSpan.innerText.split(':').at(-1).trim(),
      synopsys: synopsisParagraph.innerText,
      cover:coverElement.src
  }
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

  const novelMetadataCopy = { ...novelMetadata }
  delete novelMetadataCopy.title

  // const getApiBookSearchURL = (author, novelName, bookName) => `https://www.googleapis.com/books/v1/volumes?q=inauthor:${author},intitle:${encodeURIComponent(novelName)},intitle:${encodeURIComponent(bookName)}`;
  const getApiBookSearchURL = (author, novelName, bookName) =>
    `https://www.googleapis.com/books/v1/volumes?q=${author},${encodeURIComponent(
      novelName
    )},${encodeURIComponent(bookName)}`

  const verifyResultsItemsFunction = (item, bookName) =>
    item.volumeInfo.title.includes(bookName) ||
    item.volumeInfo?.subtitle?.includes(bookName)

  const novelCollection = JSON.parse(
    JSON.stringify(novelMetadataCopy.collection)
  )
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
      novelMetadataCopy.author,
      novelMetadataCopy.collection.name,
      volumeName
    )
  ).then(r => r.json())

  if (!bookSearchResults.totalItems || bookSearchResults.totalItems === 0) {
    //No match found
    return {
      ...novelMetadataCopy,
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
        ...novelMetadataCopy,
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
      .replace(novelMetadataCopy.collection.name, '')
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
      ...novelMetadataCopy,
      collection: novelCollection,
      volumeName: volumeName,
      synopsys: validBook.volumeInfo.description,
      cover: volumeCover ?? novelMetadataCopy.cover
    }
  }
}

async function get_firebase_app_check_token () {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open('firebase-app-check-database')

      request.onsuccess = function (event) {
        const db = event.target.result
        console.log('Bases disponibles:', db.objectStoreNames)

        // Lire un object store
        const transaction = db.transaction(
          ['firebase-app-check-store'],
          'readonly'
        )
        const store = transaction.objectStore('firebase-app-check-store')
        const getAllRequest = store.getAll()

        getAllRequest.onsuccess = function () {
          //console.log('Données récupérées:', getAllRequest.result);
          const firebase_app_check_token = getAllRequest.result[0].value.token
          resolve(firebase_app_check_token)
        }
      }
    } catch (error) {
      reject(error)
    }
  })
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

if (window.top != window.self) {
  //don't run on frames or iframes
  return
}

;(async function () {
  'use strict'

  const pathname = document.location.pathname

  if (pathname.match(/\/oeuvres\/([a-z\-0-9]+)/)) {
    //#region Oeuvre

    //unfold all volumes to load chapters in the DOM
    await waitForElement('div > h3')
    document.querySelector('input[type=text]').nextSibling.nextSibling.click() //reverse chapter order from oldest to newest

    const volumes = [...document.querySelectorAll('div > h3')].reverse()
    const novelMetadata = await getNovelMetadata()
    const localVolumesMetadata = {}

    for await (const volume of volumes) {
      volume.click()
      await waitForElement('div > h3 + ul a')

      const volumeMetadata = await getVolumeMetada(
        novelMetadata,
        volume.innerText
      )

      volumeMetadata.chapters = [
        ...volume.nextSibling.querySelectorAll('a')
      ].map(
        chapter =>
          /\/lecture\/(.+?)\/volumes\/(.+?)\/chapitres\/(.+)/.exec(chapter.getAttribute("href")).slice(1,4).join("/")
        //`${novelMetadata.collection.id}/${volume.innerText}/${chapter.href.split('/').at(-1)}`
      )
      volume.click()
      localVolumesMetadata[volume.innerText] = volumeMetadata

      const metadata = {
        title: volumeMetadata.volumeName,
        lang: 'fr',
        collections: [
          {
            ...volumeMetadata.collection,
            type: 'series'
          }
        ],
        creators: [
          {
            name: volumeMetadata.author,
            role: 'aut'
          }
        ],
        contributors: [
          {
            name: volumeMetadata.translator,
            role: 'trl'
          }
        ],
        subjects: [],
        description: volumeMetadata.synopsys ?? novelMetadata.synopsys,
        cover: volumeMetadata.cover,
        volumeName: volumeMetadata.volumeName,
        chapters: volumeMetadata.chapters
      }

      try {
        const res = await fetch(
          `${backupServerURL}/${novelMetadata.title}/${volume.innerText}`,
          {
            method: 'POST',
            'Content-Type': 'application/json',
            body: JSON.stringify(metadata),
            headers: {
              'X-Firebase-AppCheck': await get_firebase_app_check_token()
            }
          }
        )

        if (res.status === 202 || res.status === 206) {
          let new_chapters = await res.json()
          debugLog(`Volume "${volume.innerText}" processed`)
          debugLog(`New chapters: ${new_chapters.length}`)
          if (new_chapters.length <= 10) {
            debugLog('\n' + new_chapters.join('\n'))
          }
        }
      } catch (error) {}
    }
  }
})()
