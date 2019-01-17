import { createElement, createTextElement } from './html-builder';

class Message {
  constructor() {
  }

  success(message) {
    let messageElement = createElement("div", {class: 'message'}, createTextElement(message));
    document.querySelector("body").appendChild(messageElement);
    setTimeout(() => {document.querySelector("body").removeChild(messageElement)}, 2000);
  }
}

export default new Message();