import { createElement, createTextElement } from "./html-builder";

export default class Content {
  constructor(title, selector) {
    this._content_title = title ? title : "目录";
    this._content_item = [];
    selector(this);
    return this.render();
  }

  addContentItem(id, level, name) {
    this._content_item.push({
      id,
      level,
      name
    });
  }

  getTitle() {
    return this._content_title;
  }
  
  getContentItems() {
    return this._content_item;
  }

  render() {
    let contentsTitle = createElement(
      "p", {class: "contents-title"}, 
      createTextElement(this.getTitle()));

    let majorSeq = 0;
    let minorSeq = 0;

    let contentsItems = createElement("ul");
    this.getContentItems().forEach(item => {
      if (item.level === 2) {
        majorSeq++;
        minorSeq = 0;
      }
      else if (item.level === 3) {
        minorSeq++;
      }
      
      let prefix;
      if (minorSeq > 0) {
        prefix = `${majorSeq}.${minorSeq}.`;
      } else {
        prefix = `${majorSeq}.`;
      }
      
      contentsItems.appendChild(
        createElement("li", {class: `contents-level-${item.level}`}, 
          createElement("a", {href: `#${item.id}`}, createTextElement(prefix + item.name))));
    });
    let contentsElement = createElement("div");
    contentsElement.appendChild(contentsTitle);
    contentsElement.appendChild(contentsItems);

    return contentsElement;
  }
}