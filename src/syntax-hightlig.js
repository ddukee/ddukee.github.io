export default class SyntaxHighlight {
    constructor() {
        this.consoleStyle();
    }

    consoleStyle() {
        let elements = document.querySelectorAll("figure.highlight");
        elements.forEach(element => {
            let codeElement = element.querySelector("pre > code");
            let languageLabel = codeElement.getAttribute("data-lang");
            if (languageLabel === "text") {
                element.style.backgroundColor = "#000";
                element.style.borderColor = "#000";
                element.style.color = "#aaa";
            }
        });
    }
}