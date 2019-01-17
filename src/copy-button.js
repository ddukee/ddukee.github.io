import ClipboardJS from 'clipboard';
import { createElement, createTextElement } from './html-builder';
import message from './message';

export default class CopyButton {
  constructor() {
    let elements = document.querySelectorAll("figure.highlight");
    elements.forEach(element => {
      let languageLabel = element.querySelector("pre > code").getAttribute("data-lang");

      if (languageLabel !== "text") {
        let divElement = createElement("div", {class: "copy-btn"}, 
          createElement("a", {href: "#/"},
            createElement("img", {class: "copy-img", src: "/assets/images/clippy.svg"}), 
            createTextElement("复制")));

        element.insertBefore(divElement, element.querySelector("pre"));

        element.addEventListener("mouseenter", (event) => {
          let copyBtn = event.currentTarget.querySelector(".copy-btn");
          copyBtn.style.display = "block";
        });

        element.addEventListener("mouseleave", (event) => {
          let copyBtn = event.currentTarget.querySelector(".copy-btn");
          copyBtn.style.display = "none";
        });
    }});

    let clipboard = new ClipboardJS('.copy-btn', {
      target: function(trigger) {
        return trigger.nextElementSibling;
      }
    });
    
    clipboard.on('success', function(e) {
      e.clearSelection();
      message.success("复制成功");
    });
  }
}