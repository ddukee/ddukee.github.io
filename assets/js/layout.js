function resolveContent() {
  var content = []
  var headers = $(".content h2, .content h3, .content h4");
  if (headers.length > 0) {
    $.each(headers, function(key, value) {
      var header = $(value);  
      if (value.tagName === "H2") {
        content.push({value: header.text(), level: 2, id: value.id})
      }
      else if (value.tagName === "H3") {
        content.push({value: header.text(), level: 3, id: value.id})
      }
    })
  }
  return content;
}

function renderContent() {
  var content = resolveContent();
  var contentElement = $("#contents");
  html = "<p class=\"contents-title\">目录</p><ul>";
  var major = 0;
  var minor = 0;
  $.each(content, function(key, value) {
    if (value.level === 2) {
      major++;
      minor = 0;
    }
    else if (value.level === 3) {
      minor++;
    }
    var prefix = major + ".";
    if (minor > 0) {
      prefix += minor + ".";
    }
    html += 
    "<li " + "class=" + "\"contents-level-" + value.level + "\">" +
    "<a href=\"#" + value.id + "\">" + prefix + value.value + "</a>"
    "</li>";
  });
  html += "</ul>";
  contentElement.html(html);
}

function copyBtn() {
  var clipboard = new ClipboardJS('.copy-btn', {
    target: function(trigger) {
      return trigger.nextElementSibling;
    }
  });
  
  clipboard.on('success', function(e) {
    e.clearSelection();
  });
  
  var codeElement = $("figure.highlight");
  codeElement.prepend("<div class=\"copy-btn\"><a href=\"#/\"><img class=\"copy-img\" src=\"/assets/images/clippy.svg\"></img>复制</a></div>");
  
  $(".copy-btn > a").mousedown(function() {
    $(this).fadeOut(50);
    $(this).fadeIn(100);
  });
  
  codeElement.hover(
    function() {
      var copyBtnElement = $(this).find(".copy-btn");
      copyBtnElement.fadeIn(100);
    },
    function() {
      var copyBtnElement = $(this).find(".copy-btn");
      copyBtnElement.fadeOut(100);
    })
}

$(function() {
  renderContent();
  copyBtn();
})