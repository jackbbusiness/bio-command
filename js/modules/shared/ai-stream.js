"use strict";

/**
 * The one place that knows how a prompt reaches Claude and how the
 * response streams back. Every feature module that wants an AI
 * response calls createAdvisor({ transport }).ask(...) -- none of
 * them construct an Anthropic request directly. Swapping the browser-
 * direct call for a future Supabase Edge Function proxy means writing
 * one new transport and changing what gets passed to createAdvisor;
 * no feature module changes.
 *
 * A transport is anything with an async generator `send({ system,
 * prompt, signal, model, maxTokens })` that yields text deltas.
 * browserAnthropicTransport is the only one that exists today. model/
 * maxTokens given to send() override the transport's own defaults for
 * that one call (e.g. a quick JSON-extraction call wants a low token
 * cap; a full week's meal plan needs a much higher one) -- consumers
 * that don't care just get the transport-level default.
 */
(function (global) {
  function createBrowserAnthropicTransport({ getApiKey, model: defaultModel = "claude-sonnet-4-6", maxTokens: defaultMaxTokens = 700 } = {}) {
    async function* send({ system, prompt, signal, model, maxTokens } = {}) {
      const key = getApiKey && getApiKey();
      if (!key) throw new Error("SET KEY IN SYS");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: model || defaultModel,
          max_tokens: maxTokens || defaultMaxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
          stream: true
        }),
        signal
      });

      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
          const data = await res.json();
          if (data && data.error && data.error.message) msg = data.error.message;
        } catch (e) { /* body wasn't JSON -- keep the HTTP-status message */ }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop(); // last (possibly incomplete) line stays buffered
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          let evt;
          try { evt = JSON.parse(jsonStr); } catch (e) { continue; }
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
            yield evt.delta.text;
          } else if (evt.type === "error") {
            throw new Error((evt.error && evt.error.message) || "Stream error");
          }
        }
      }
    }
    return { send };
  }

  function createAdvisor({ transport }) {
    async function ask(prompt, { system, onToken, onDone, onError, signal, model, maxTokens } = {}) {
      let full = "";
      try {
        for await (const delta of transport.send({ system, prompt, signal, model, maxTokens })) {
          full += delta;
          if (typeof onToken === "function") onToken(delta, full);
        }
        if (typeof onDone === "function") onDone(full);
        return full;
      } catch (e) {
        if (typeof onError === "function") onError(e);
        else throw e;
        return full;
      }
    }
    return { ask };
  }

  // Always appends via a text node -- never innerHTML -- so rendering
  // streamed tokens can't reopen the C1 XSS fix regardless of what a
  // model ever returns.
  function appendToken(el, text) {
    el.appendChild(document.createTextNode(text));
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.aiStream = { createAdvisor, createBrowserAnthropicTransport, appendToken };
})(window);
