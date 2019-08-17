export default class TopJumper {
  constructor(classSelector) {
    this.selector = classSelector;
    this.initJumper();
  }
  
  initJumper() {
    let elements = document.getElementsByClassName(this.selector)
    if (elements.length > 0) {
      let element = elements[0]
      element.addEventListener("click", () => {
        window.scrollTo({
          left: 0,
          top: 0,
          behavior: 'smooth'
        });
      });
    }
  }
}