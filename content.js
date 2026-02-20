// Only run in the TOP frame — not in iframes
if (window !== window.top) throw new Error('IGR: Skipping iframe');

console.log("IGR Scraper: Content Script Loaded");


let extractionConfig = {
    linkSelector: "input[value='IndexII'], input[id*='btnIndex2'], a[id*='btnIndex2'], a.view-link, a[href*='Index2']",
    highlightColor: "3px solid #6366f1",
    delay: 3000
};

function sendLog(message, logType = 'info') {
    if (isContextValid()) {
        chrome.runtime.sendMessage({ action: 'log', message, logType }).catch(() => { });
    }
}

// Helper to check if extension context is still valid
function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
}

// Polling/Resume logic
function checkAndRun() {
    if (!isContextValid()) return;

    chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
        if (data.isRunning) {
            console.log(`IGR Scraper: Resuming execution (Page ${data.pages || 0})...`);
            sendLog(`Resuming extraction on Page ${data.pages || 0}...`, 'info');
            scrapeWithRetry(data.urls || [], data.pages || 0);
        }
    });
}

async function scrapeWithRetry(existingUrls, pagesCount, attempt = 1) {
    if (!isContextValid()) return;

    console.log(`IGR Scraper: Scanning page, attempt ${attempt}...`);
    if (attempt === 1) sendLog(`Scanning Page ${pagesCount + 1} for documents...`, 'info');

    // 1. Find the Grid
    const grid = document.getElementById('RegistrationGrid');
    if (!grid) {
        console.warn("RegistrationGrid not found yet.");
    }

    // 2. Find all buttons (Targeting the specific onclick structure you mentioned)
    const allLinks = document.querySelectorAll("input[value='IndexII'], input.Button[onclick*='indexII'], a[id*='btnIndex2']");

    if (allLinks.length === 0 && attempt < 6) {
        console.log("No buttons found yet, retrying in 2.5s...");
        setTimeout(() => scrapeWithRetry(existingUrls, pagesCount, attempt + 1), 2500);
        return;
    }

    if (allLinks.length === 0) {
        sendLog("No documents found. Make sure search results are visible.", "warn");
        return;
    }

    sendLog(`Found ${allLinks.length} documents. Starting extraction...`, "success");
    scrapePage(existingUrls, pagesCount, Array.from(allLinks));
}

// Listen for messages FROM background or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isContextValid()) return;

    if (request.action === 'start') {
        chrome.storage.local.set({ isRunning: true }, () => {
            checkAndRun();
        });
    }

    if (request.action === 'stop') {
        chrome.storage.local.set({ isRunning: false });
        sendLog("Extraction stopped.", "warn");
    }

    if (request.action === 'clickButton') {
        const targetAttr = `indexII$${request.index}`;

        // 1. Clear previous flags
        document.querySelectorAll('[data-target-active]').forEach(el => {
            el.removeAttribute('data-target-active');
            el.style.border = '';
            el.style.backgroundColor = '';
        });

        // 2. Re-scan DOM
        let btn = document.querySelector(`input[onclick*="${targetAttr}"]`);

        if (!btn) {
            const allBtns = Array.from(document.querySelectorAll("input[type='button'], input.Button"));
            btn = allBtns.find(b => (b.getAttribute('onclick') || '').includes(targetAttr));
        }

        if (btn) {
            console.log(`IGR Scraper: Found Row ${request.index + 1} button`);
            btn.style.border = "2px solid #6366f1";
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            btn.setAttribute('data-target-active', 'true');

            // 3. New logic: Perform the click internally if requested
            if (request.performClick) {
                console.log(`IGR Scraper: Triggering click for Row ${request.index + 1}`);
                setTimeout(() => {
                    btn.click();
                }, 500);
            }

            // Send success back to background
            if (sendResponse) sendResponse({ success: true });
        } else {
            if (sendResponse) sendResponse({ success: false });
        }
        return true;
    }

    if (request.action === 'pageFinished') {
        chrome.storage.local.get(['isRunning', 'pages'], (data) => {
            if (!data.isRunning) return;

            const nextPagesCount = (data.pages || 0) + 1;
            chrome.storage.local.set({ pages: nextPagesCount });

            const nextBtn = findNextButton();
            if (nextBtn) {
                console.log("IGR Scraper: Batch finished. Moving to next page...");
                sendLog(`Moving to Page ${nextPagesCount + 1}...`, "info");
                nextBtn.setAttribute('data-scraper-id', 'next-page-btn');
                // Tell background to click the next page AND then trigger a rescan
                chrome.runtime.sendMessage({
                    action: 'triggerNextPage',
                    nextPage: nextPagesCount
                });
            } else {
                console.log("IGR Scraper: All pages finished.");
                sendLog("No more pages found. Sequence finished.", "success");
                chrome.storage.local.set({ isRunning: false });
                chrome.runtime.sendMessage({ action: 'finished' });
            }
        });
    }

    // Background asks content.js to scan the newly loaded page after AJAX pagination
    if (request.action === 'rescan') {
        chrome.storage.local.get(['isRunning', 'urls', 'pages'], (data) => {
            if (!data.isRunning) return;
            console.log(`IGR Scraper: Rescanning after pagination (Page ${data.pages || 0})...`);
            sendLog(`Scanning Page ${(data.pages || 0) + 1} for documents...`, 'info');
            scrapeWithRetry(data.urls || [], data.pages || 0);
        });
    }
});


async function scrapePage(existingUrls, pagesCount, allLinks) {
    if (!isContextValid()) return;

    const queueForBackground = [];
    const newLinks = [];

    allLinks.forEach((link, index) => {
        // Attempt to extract the TRUE index from the onclick attribute
        let realIndex = index;
        const onclickText = link.getAttribute('onclick') || '';
        const match = onclickText.match(/indexII\$(\d+)/);
        if (match) realIndex = parseInt(match[1]);

        const scraperId = `btn_p${pagesCount}_i${realIndex}`;
        link.setAttribute('data-scraper-id', scraperId);

        link.style.border = extractionConfig.highlightColor;
        link.style.boxShadow = "0 0 10px rgba(99, 102, 241, 0.5)";

        let docName = "IGR_Doc";
        try {
            const row = link.closest('tr');
            if (row && row.cells.length >= 3) {
                const docNo = row.cells[0].innerText.trim();
                const dName = row.cells[1].innerText.trim();
                const rDate = row.cells[2].innerText.trim();
                docName = `${docNo}_${dName}_${rDate}`.replace(/[\\/:*?"<>|]/g, '_');
                docName = docName.replace(/[\s.]+$/, '').substring(0, 80);
            }
        } catch (e) {
            console.error("Naming error:", e);
        }

        let item = {
            id: scraperId,
            index: realIndex, // Crucial for re-finding the button after refresh
            filename: `${docName}_P${pagesCount + 1}_R${realIndex + 1}`,
            text: "IndexII",
            scrapedAt: new Date().toISOString()
        };

        newLinks.push(item);
        queueForBackground.push({ id: scraperId, index: realIndex, filename: item.filename });
    });

    const updatedUrls = [...existingUrls, ...newLinks];
    chrome.storage.local.get(['isRunning'], (data) => {
        if (!data.isRunning) return;

        chrome.storage.local.set({ urls: updatedUrls });
        chrome.runtime.sendMessage({
            action: 'updateStats',
            urls: updatedUrls.length,
            pages: pagesCount + 1
        });

        if (queueForBackground.length > 0) {
            sendLog(`Enqueueing ${queueForBackground.length} documents for download...`, 'info');
            chrome.runtime.sendMessage({
                action: 'enqueueDownloads',
                links: queueForBackground
            });
        }
    });
}

function findNextButton() {
    // ── Strategy 1: ASP.NET Page$N postback pattern (most reliable for IGR)
    // Find all pagination links using the __doPostBack Page$N pattern
    const allPageLinks = Array.from(document.querySelectorAll("a[href*='Page$'], a[onclick*='Page$']"));

    if (allPageLinks.length > 0) {
        // Find current page — it's a <span> (not a link) inside the grid's last row
        const grid = document.getElementById('RegistrationGrid');
        let currentPage = 1;

        if (grid) {
            // The current page is shown as a <span> or <b> (not a link) in the pager row
            const pagerRow = grid.querySelector('tr:last-child');
            if (pagerRow) {
                const currentSpan = pagerRow.querySelector('span, b');
                if (currentSpan) {
                    const parsed = parseInt(currentSpan.innerText.trim());
                    if (!isNaN(parsed)) currentPage = parsed;
                }
            }
        }

        // Find link for page currentPage + 1
        const nextPageNum = currentPage + 1;
        const nextLink = allPageLinks.find(a => {
            const txt = (a.innerText || a.textContent || '').trim();
            return parseInt(txt) === nextPageNum;
        });
        if (nextLink) {
            console.log(`IGR Scraper: Found next page link → Page ${nextPageNum}`);
            return nextLink;
        }

        // If next number not visible, check for "..." link AFTER current page
        const ellipsisLinks = allPageLinks.filter(a =>
            (a.innerText || '').trim() === '...' &&
            (a.getAttribute('onclick') || '').includes(`Page$${nextPageNum}`)
        );
        if (ellipsisLinks.length > 0) return ellipsisLinks[0];
    }

    // ── Strategy 2: Search inside RegistrationGrid pager row by background color
    const grid = document.getElementById('RegistrationGrid');
    if (grid) {
        const pagerSelectors = [
            "tr[style*='background-color:#CCCCCC'] table",
            "tr[style*='background-color:Silver'] table",
            "tr[style*='background-color: #CCCCCC'] table",
            "tr.GridPager table",
            "tr td[colspan] table"
        ];
        for (const sel of pagerSelectors) {
            const paginationTable = grid.querySelector(sel);
            if (paginationTable) {
                const currentSpan = paginationTable.querySelector("span");
                const links = Array.from(paginationTable.querySelectorAll("a"));
                if (currentSpan && links.length > 0) {
                    const currentPageNum = parseInt(currentSpan.innerText);
                    for (let link of links) {
                        if (parseInt(link.innerText) === currentPageNum + 1) return link;
                    }
                    // Look for "..." after current page
                    for (let link of links) {
                        if (link.innerText.trim() === '...') {
                            const allTds = Array.from(paginationTable.querySelectorAll("td"));
                            const spanTd = currentSpan.closest("td");
                            const linkTd = link.closest("td");
                            if (allTds.indexOf(linkTd) > allTds.indexOf(spanTd)) return link;
                        }
                    }
                }
            }
        }
    }

    // ── Strategy 3: Generic text match (last resort)
    for (const el of document.querySelectorAll('a, button, input[type="button"]')) {
        const text = (el.innerText || el.value || '').toLowerCase().trim();
        if (['next', '>>', 'next page', '›', '»'].includes(text)) return el;
    }

    return document.querySelector("[id*='btnNext'], .next, .PagerNext, [id*='lnkNext']");
}

if (document.readyState === 'complete') {
    setTimeout(checkAndRun, 2500);
} else {
    window.addEventListener('load', () => setTimeout(checkAndRun, 2500));
}

window.onerror = function (msg, url, line) {
    console.log("IGR Scraper Error:", msg, "at", line);
    return false;
};
