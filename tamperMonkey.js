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

const backupServerURL = "https://fuck-victorian-novel-house.lerouxnard.fr/";

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
`;

function wait(time) {
	return new Promise((res) => setTimeout(res, time));
}

function waitForElement(selector, timeout=10_000) {
	return new Promise((res, rej) => {
		const observer = new MutationObserver((mutations, observer) => {
			const element = document.querySelector(selector);
			if (element) {
				observer.disconnect();
				res();
			}
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});

		setTimeout(() => {
			observer.disconnect()
			rej()
		}, timeout)
	});
}

function waitForChapterLoad(selector) {
	return new Promise((res) => {
		const observer = new MutationObserver(() => {
			observer.disconnect();
			res();
		});

		// call `observe()`, passing it the element to observe, and the options object
		observer.observe(document.querySelector(selector), {
			subtree: true,
			characterData: true,
		});

		observer.observe(document.querySelector(selector), {
			subtree: true,
			childList: true,
		});
	});
}

function waitForTabToBeClosed(tab) {
	return new Promise((res) =>
		setInterval(() => {
			if (tab.closed) res();
		}, 500)
	);
}

async function loadCSSCors(stylesheet_uri) {
	return new Promise((res) => {
		var xhr = new XMLHttpRequest();
		xhr.open("GET", stylesheet_uri);
		xhr.onload = function () {
			xhr.onload = xhr.onerror = null;
			if (xhr.status < 200 || xhr.status >= 300) {
				alert("style failed to load: " + stylesheet_uri);
			} else {
				var style_tag = document.createElement("style");
				style_tag.appendChild(document.createTextNode(xhr.responseText));
				document.head.appendChild(style_tag);
				res();
			}
		};
		xhr.onerror = function () {
			xhr.onload = xhr.onerror = null;
			alert("XHR CORS CSS fail:" + stylesheet_uri);
		};
		xhr.send();
	});
}

async function waitForLocalStorage(key, interval = 100) {
	return new Promise((res) => {
		let checker = setInterval(async () => {
			const keys = await GM.listValues();
			if (keys.includes(key)) {
				clearInterval(checker);
				const value = GM.getValue(key);
				GM.deleteValue(key);
				return res(value);
			}
		}, interval);
	});
}

function openInNewTab(url) {
	const a = document.createElement("a");
	a.href = url;
	a.target = "_blank";
	a.rel = "noopener noreferrer";
	a.referrerPolicy = "no-referrer";
	document.body.appendChild(a);
	a.click();
	a.remove();
}

async function getImageData(url) {
	openInNewTab(url);
	return await waitForLocalStorage(url.split("/").at(-1));
}

async function getNovelMetadata() {
	const novelTitleNode = document.querySelector("h2");
	const synopsisParagraph = document.querySelector("section > div > div > p");
	const authorSpan = document.querySelector("section > div span:nth-child(1)");
	const translatorSpan = document.querySelector("section > div span:nth-child(2)");
	const coverElement = document.querySelector("section div img");
	const coverDataURL = await getImageData(coverElement.src);

	return {
		author: authorSpan.innerText.split(":").at(-1).trim(),
		collection: {
			id: window.location.pathname.split("/").at(-1),
			name: novelTitleNode.innerText,
		},
		translator: translatorSpan.innerText.split(":").at(-1).trim(),
		synopsys: synopsisParagraph.innerText,
		cover: coverDataURL,
	};
}

async function getVolumeMetada(novelMetadata, volumeName) {
	let volumeNumber;
	[volumeName, volumeNumber] = /(?<=(\d+) - ).+|^.+ (\d+)$/.exec(volumeName).filter((value) => !!value) ?? [volumeName, 0];

	// const getApiBookSearchURL = (author, novelName, bookName) => `https://www.googleapis.com/books/v1/volumes?q=inauthor:${author},intitle:${encodeURIComponent(novelName)},intitle:${encodeURIComponent(bookName)}`;
	const getApiBookSearchURL = (author, novelName, bookName) => `https://www.googleapis.com/books/v1/volumes?q=${author},${encodeURIComponent(novelName)},${encodeURIComponent(bookName)}`;

	const verifyResultsItemsFunction = (item, bookName) => item.volumeInfo.title.includes(bookName) || item.volumeInfo?.subtitle?.includes(bookName);

	novelCollection = JSON.parse(JSON.stringify(novelMetadata.collection));
	novelCollection.number = volumeNumber;

	let bookSearchResults;
	let availableTitleVariation = [volumeName, `Vol ${volumeNumber}`, `Vol. ${volumeNumber}`, `Book ${volumeNumber}`];

	bookSearchResults = await fetch(getApiBookSearchURL(novelMetadata.author, novelMetadata.collection.name, volumeName)).then((r) => r.json());

	if (bookSearchResults.totalItems === 0) {
		//No match found
		return {
			...novelMetadata,
			collection: novelCollection,
			volumeName: volumeName,
		};
	} else {
		let validBook;
		for (const variation of availableTitleVariation) {
			validBook = bookSearchResults.items.find((i) => verifyResultsItemsFunction(i, variation));
			if (!!validBook) break;
		}
		if (!validBook) {
			return {
				...novelMetadata,
				collection: novelCollection,
				volumeName: volumeName,
			};
		}
		let bookName = `${validBook.volumeInfo.title} ${validBook.volumeInfo.subtitle ?? ""}`;

		availableTitleVariation.shift(); // remove the book title from the loop to avoid it being replaced

		for (variation of availableTitleVariation) {
			bookName = bookName.replace(variation, "");
		}

		bookName = bookName
			.replace(novelMetadata.collection.name, "")
			.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
			.trim();

		if (bookName == "") {
			bookName = validBook.volumeInfo.title;
		}

		let volumeCover;
		if (!!validBook.volumeInfo?.imageLinks?.thumbnail) {
			volumeCover = `https://books.google.com/books/publisher/content/images/frontcover/${validBook.id}?fife=w10000`;
		}

		return {
			...novelMetadata,
			collection: novelCollection,
			volumeName: volumeName,
			synopsys: validBook.volumeInfo.description,
			cover: volumeCover ?? novelMetadata.cover,
		};
	}
}

async function checkIfExportAlreadyExists(volumeMetadata, chapterName) {
	const collectionName = volumeMetadata.collection.name.replace(/[^A-Za-z0-9]/g, "_");
	const volumeName = volumeMetadata.volumeName.replace(/[^A-Za-z0-9]/g, "_");
	const url = `${backupServerURL}/${collectionName}/${volumeName}/${chapterName}.epub`;

	return await new Promise(async(fullfill) => {
		let xhr = new XMLHttpRequest();
		xhr.open("HEAD", url);
		xhr.onload = function () {
			fullfill(xhr.status == 302)
		};
		xhr.send();
	});
}

(async function () {
	"use strict";

	const params = window.location.search;
	const pathname = document.location.pathname;

	if (pathname.match(/\/images\/.+?\/.+/)) {
		//#region Gestion des Images
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		const img = document.querySelector("img");

		canvas.width = img.width;
		canvas.height = img.height;

		ctx.drawImage(img, 0, 0, img.width, img.height);

		const localStorageKey = pathname.split("/").at(-1);
		await GM.setValue(localStorageKey, canvas.toDataURL("image/png"));
		return window.close();
		//#endregion
	}

	if (pathname.match(/\/oeuvres\/([a-z\-0-9]+)/)) {
		//#region Oeuvre

		//unfold all volumes to load chapters in the DOM
		await waitForElement("div > h3");
		const volumes = [...document.querySelectorAll("div > h3")];
		const novelMetadata = await getNovelMetadata();
		await window.localStorage.setItem(`${novelMetadata.collection.id}`, JSON.stringify(novelMetadata));

		volumes.reverse();

		const localVolumesMetadata = {};
		for await (const volume of volumes) {
			const volumeMetadata = await getVolumeMetada(novelMetadata, volume.innerText);
			localVolumesMetadata[volume.innerText] = volumeMetadata;
			window.localStorage.setItem(`${volumeMetadata.collection.id}-${volumeMetadata.collection.number}`, JSON.stringify(volumeMetadata));
		}

		if (!params.includes("dump=true")) return;

		for await (const volume of volumes) {
			volume.click();
			let volumeMetadata = localVolumesMetadata[volume.innerText];
			await waitForElement("div > ul a");
			const chapters = [...volume.nextSibling.querySelectorAll("a")];
			for await (const chapter of chapters.reverse()) {
				const shouldSkip = await checkIfExportAlreadyExists(volumeMetadata, decodeURIComponent(chapter.href.split("/").at(-1)));
				if (shouldSkip) continue;
				let tab = window.open(`${chapter.href}?dump=true&close=true`, "_blank");
				await waitForTabToBeClosed(tab);
			}
			volume.click();
		}

		return;
		//#endregion
	} else if (pathname.match(/\/lecture\/(['a-z\-0-9]+)\/volumes\/.+\/chapitres\/(.+)/)) {
		if (!params.includes("dump=true")) return;

		//#region Chapitre
		const chapterContentLocator = "#textContainer > .chapter-obf";

		try {
			await waitForElement(chapterContentLocator, 3_000);
		}catch {
			const buttons = [...document.querySelectorAll("button")];
			const loadchapterButton = buttons.find(b => b.innerText == "Charger le chapitre")
			if(!!loadchapterButton){
				loadchapterButton.click()
			}
			await waitForElement(chapterContentLocator);
		}

		try {
			const cssSheet = [...document.querySelectorAll("link[rel=stylesheet]")].find((s) => s.href.includes("chapitre"));
			await loadCSSCors(cssSheet.href);

			for (const styleSheet of document.styleSheets) {
				try {
					for (const rule of styleSheet.cssRules) {
						if (!!rule && !!rule.style && rule.style["font-size"] === "0px") {
							document.querySelectorAll(rule.selectorText).forEach((e) => e.remove());
						}
					}
				} catch (err) {}
			}

			const chapterContainer = document.querySelector(chapterContentLocator);
			let chapterContent = chapterContainer.innerHTML;

			chapterContent = chapterContent.replace(/<span class=".{8}">|<\/span>/g, "");
			chapterContent = chapterContent.replace(/(?:<br\s*\/*>)+/, "\n");

			const chapterImages = {};
			for await (const image of [...chapterContainer.querySelectorAll("img")]) {
				let newImageName = image.alt.replace(/\..+?$/, ".png");
				if (newImageName in chapterImages) return alert("Image ALT already used ! something might be wrong");
				const imageDataURL = await getImageData(image.src);
				chapterImages[newImageName] = imageDataURL;
				chapterContent = chapterContent.replace(image.src, `images/${newImageName}`).replace(image.alt, "");
			}

			chapterContent = `${lineBreakStyle}\n${chapterContent}`; //ajout de la feuille de style custom en premier

			// Remplace ceci par l'URL de ton webhook Discord
			const formData = new FormData();

			let imageKeys = Object.keys(chapterImages);
			let i = 0;
			for (i in imageKeys) {
				let imageName = imageKeys[i];
				let pictureDataURL = chapterImages[imageName];
				const byteString = atob(pictureDataURL.split(",")[1]); // Décodage de la partie base64
				const arrayBuffer = new ArrayBuffer(byteString.length);
				const uintArray = new Uint8Array(arrayBuffer);

				for (let j = 0; j < byteString.length; j++) {
					uintArray[j] = byteString.charCodeAt(j);
				}

				const blob = new Blob([uintArray], { type: "image/png" }); // Change le type en fonction du format
				const file = new File([blob], imageName, { type: "image/png" });

				formData.append(`files[${i}]`, file);
			}

			const uint8ArrayChapterContent = new TextEncoder().encode(chapterContent);
			const chapterContentBlob = new Blob([uint8ArrayChapterContent], { type: "text/html" });
			const chapterFile = new File([chapterContentBlob], `chapter.html`, { type: "text/html" });

			i += 1; // incrémente pour intégrer le chapitre

			formData.append(`files[${i}]`, chapterFile);

			const novelName = document
				.querySelector("main div div a:nth-child(2)")
				.innerText.toLowerCase()
				.replace(/[^'a-z]/g, "-");

			const chapterName = document.querySelector("main div div span:nth-of-type(2)").innerText;
			const volumeNumber = document.querySelector("main div div span").innerText.replace(/[^0-9]/g, "") ?? "0";
			const localStorageMetadata = JSON.parse(await window.localStorage.getItem(`${novelName}-${volumeNumber}`));
			if (!localStorageMetadata) return alert("Impossible d'extraire ce chapitre, merci de charger la page de l'oeuvre dans un premier temps");

			const metadata = {
				title: chapterName,
				lang: "fr",
				collections: [
					{
						...localStorageMetadata.collection,
						type: "series",
					},
				],
				creators: [
					{
						name: localStorageMetadata.author,
						role: "aut",
					},
				],
				contributors: [
					{
						name: localStorageMetadata.translator,
						role: "trl",
					},
				],
				subjects: [],
				description: localStorageMetadata.synopsys,
				cover: localStorageMetadata.cover,
				volumeName: localStorageMetadata.volumeName,
			};

			const uint8ArrayMetadata = new TextEncoder().encode(JSON.stringify(metadata, null, 4));
			const metadataBlob = new Blob([uint8ArrayMetadata], { type: "application/json" });
			const metadataFile = new File([metadataBlob], `metadata.json`, { type: "application/json" });
			i += 1; // incrémente pour intégrer les métadonnées du chapitre

			formData.append(`files[${i}]`, metadataFile);

			try {
				await fetch(backupServerURL, {
					method: "POST",
					body: formData,
				});
			} catch (error) {
				console.error("❌ Erreur lors de l'envoi :", error);
			}

			if (params.includes("close=true")) {
				return window.close();
			}
		} catch (err) {
			alert(err);
		}
		//#endregion
	}
})();
