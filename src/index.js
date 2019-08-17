import Content from "./content";
import CopyButton from './copy-button';
import SyntaxHighlight from './syntax-hightlig';
import TopJumper from './top-jumper';

document.addEventListener(
  'DOMContentLoaded', 
  function() {
    let contents = new Content("目录", content => {
      let headers = document.querySelectorAll(".content h2, .content h3, .content h4");
      headers.forEach((header) => {
        switch(header.tagName) {
          case "H2":
            content.addContentItem(header.id, 2, header.textContent);
            break;
          case "H3":
            content.addContentItem(header.id, 3, header.textContent);
            break;
        }
      });
    });

    let contentsRoot = document.querySelector("#contents");
    if (contentsRoot !== undefined && contentsRoot !== null) {
      contentsRoot.appendChild(contents);
    }
    new CopyButton();
    new SyntaxHighlight();
    new TopJumper("jump-top");
  }, 
false);