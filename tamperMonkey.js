// ==UserScript==
// @name         Dump Chapters 2.0
// @namespace    http://tampermonkey.net/
// @version      2025-07-29
// @description  try to take over the world!
// @author       You
// @match        https://world-novel.fr/oeuvres/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=victorian-novel-house.fr
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.listValues
// ==/UserScript==

const corsBypassProxy = 'https://fuck-cors.lerouxnard.workers.dev'
const backupServerURL = 'https://fuck-victorian-novel-house.lerouxnard.fr/'


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


async function getNovelMetadata () {
  const novelTitleNode = document.querySelector('h2')
  const synopsisParagraph = document.querySelector('section > div > div > p')
  const authorSpan = document.querySelector('section > div span:nth-child(1)')
  const translatorSpan = document.querySelector(
    'section > div span:nth-child(2)'
  )
  const coverElement = document.querySelector('section div img')

  return [
    {
      title: novelTitleNode.innerText,
      author: authorSpan.innerText.split(':').at(-1).trim(),
      collection: {
        id: window.location.pathname.split('/').at(-1),
        name: novelTitleNode.innerText
      },
      translator: translatorSpan.innerText.split(':').at(-1).trim(),
      synopsys: synopsisParagraph.innerText
    },
    coverElement.src
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

  if (bookSearchResults.totalItems === 0) {
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

;(async function () {
  'use strict'

  const pathname = document.location.pathname

  if (pathname.match(/\/oeuvres\/([a-z\-0-9]+)/)) {
    //#region Oeuvre

    //unfold all volumes to load chapters in the DOM
    await waitForElement('div > h3')
    document.querySelector('input[type=text]').nextSibling.nextSibling.click() //reverse chapter order from oldest to newest

    const volumes = [...document.querySelectorAll('div > h3')].reverse()
    const [novelMetadata, coverBlobUrl] = await getNovelMetadata()
    const localVolumesMetadata = {}

    for await (const volume of volumes) {
      volume.click()
      await waitForElement('div > h3 + ul a')


      const volumeMetadata = await getVolumeMetada(
        novelMetadata,
        volume.innerText
      )

      if (!volumeMetadata.cover) {
        volumeMetadata.cover = coverBlobUrl
      }
      volumeMetadata.chapters = [
        ...volume.nextSibling.querySelectorAll('a')
      ].map(
        chapter =>
          /\/lecture\/(.+?)\/volumes\/(.+?)\/chapitres\/(.+)/.exec(chapter.href).slice(1,4).join("/")
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
        description: volumeMetadata.synopsys,
        cover: volumeMetadata.cover,
        volumeName: volumeMetadata.volumeName,
        chapters: volumeMetadata.chapters
      }

      try {
        await fetch(
          `${backupServerURL}/${novelMetadata.title}/${volume.innerText}`,
          {
            method: 'POST',
            "Content-Type": "application/json",
            body: JSON.stringify(metadata)
          }
        )
      } catch (error) {}
    }
  }
})()
