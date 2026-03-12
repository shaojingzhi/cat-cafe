const { setGlobalDispatcher, ProxyAgent } = require('undici')

function configureGlobalProxy() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy

  if (!proxyUrl) {
    return { enabled: false, proxyUrl: null }
  }

  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl)
  setGlobalDispatcher(new ProxyAgent(normalizedProxyUrl))
  return { enabled: true, proxyUrl: normalizedProxyUrl }
}

function normalizeProxyUrl(proxyUrl) {
  if (/^https:\/\/127\.0\.0\.1(?::\d+)?$/i.test(proxyUrl)) {
    return proxyUrl.replace(/^https:/i, 'http:')
  }

  return proxyUrl
}

module.exports = {
  configureGlobalProxy,
}
