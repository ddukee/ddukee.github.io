export function createElement(tagName, attribute = {}, ...childElements) {
    let element = document.createElement(tagName);
    for (let key in attribute) {
        element.setAttribute(key, attribute[key]);
    }

    if (childElements.length > 0) {
        childElements.forEach(childElement => element.appendChild(childElement));
    }

    return element;
}

export function createTextElement(text) {
    return document.createTextNode(text);
}